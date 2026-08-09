import { describe, expect, it } from "vitest";
import { analyzeConversationPortability } from "../src/portability.ts";
import type { Api, AssistantMessage, AttachmentRecord, Message, Model } from "../src/types.ts";

function model(provider: string, api: Api, id: string, baseUrl: string): Model<Api> {
	return {
		provider,
		api,
		id,
		name: id,
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

describe("provider-native conversation IR and portability", () => {
	it("keeps legacy message JSON byte-for-byte additive", () => {
		const legacy: Message = { role: "user", content: "hello", timestamp: 1 };
		expect(JSON.stringify(legacy)).toBe('{"role":"user","content":"hello","timestamp":1}');
	});

	it("round-trips native reasoning, citations, tool metadata and provider state", () => {
		const message = assistant({
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "legacy-signature", redacted: true },
				{
					type: "toolCall",
					id: "call_1",
					name: "web_search",
					arguments: { query: "Pi" },
					providerMetadata: { serverToolUseId: "srv_1" },
				},
			],
			nativeParts: [
				{
					type: "provider-native",
					provider: "anthropic",
					api: "anthropic-messages",
					modelId: "claude-sonnet-4-6",
					kind: "cache_control",
					payload: { type: "ephemeral" },
					stateId: "cache_1",
				},
			],
			citations: [{ type: "citation", sourceId: "doc_1", title: "Paper", url: "https://example.com/paper" }],
			reasoningState: [
				{
					provider: "anthropic",
					api: "anthropic-messages",
					modelId: "claude-sonnet-4-6",
					encrypted: "opaque-encrypted-payload",
					signature: "opaque-signature",
				},
			],
			providerState: {
				provider: "anthropic",
				api: "anthropic-messages",
				modelId: "claude-sonnet-4-6",
				responseId: "msg_123",
				continuationId: "continuation_123",
			},
		});

		expect(JSON.parse(JSON.stringify(message))).toEqual(message);
	});

	it("classifies same-backend native state as portable and a provider switch as locked", () => {
		const messages = [
			assistant({
				nativeParts: [
					{
						type: "provider-native",
						provider: "anthropic",
						api: "anthropic-messages",
						kind: "server_tool_state",
						payload: { id: "srv_1" },
					},
				],
				reasoningState: [{ provider: "anthropic", api: "anthropic-messages", encrypted: "opaque" }],
				providerState: { provider: "anthropic", api: "anthropic-messages", responseId: "msg_1" },
			}),
		];
		const same = analyzeConversationPortability({
			messages,
			target: model("anthropic", "anthropic-messages", "claude-sonnet-4-6", "https://api.anthropic.com"),
		});
		expect(same.canSwitchWithoutLoss).toBe(true);
		expect(same.counts.portable).toBe(3);

		const switched = analyzeConversationPortability({
			messages,
			target: model("openai", "openai-responses", "gpt-5.6", "https://api.openai.com/v1"),
		});
		expect(switched.canSwitchWithoutLoss).toBe(false);
		expect(switched.counts["provider-locked"]).toBe(3);
	});

	it("reports reconstructable, missing, unsupported and provider-owned attachment states", () => {
		const attachments: AttachmentRecord[] = [
			{
				id: "att_pdf",
				filename: "paper.pdf",
				mediaType: "application/pdf",
				source: { type: "path", path: "/available/paper.pdf" },
			},
			{
				id: "att_video",
				filename: "demo.mp4",
				mediaType: "video/mp4",
				source: { type: "base64", data: "AAAA" },
			},
			{
				id: "att_google",
				filename: "google.pdf",
				mediaType: "application/pdf",
				source: { type: "provider-file", provider: "google", fileId: "files/1" },
			},
		];
		const messages: Message[] = [
			{
				role: "user",
				content: "compare",
				attachments: ["att_pdf", "att_video", "att_google", "att_missing"].map((attachmentId) => ({
					type: "attachment" as const,
					attachmentId,
				})),
				timestamp: 1,
			},
		];
		const report = analyzeConversationPortability({
			messages,
			attachments,
			target: model("anthropic", "anthropic-messages", "claude-sonnet-4-6", "https://api.anthropic.com"),
			sourceAvailable: (attachment) => attachment.id !== "att_pdf" || attachment.source.type === "path",
		});
		expect(report.counts.reconstructable).toBe(1);
		expect(report.counts.unsupported).toBe(1);
		expect(report.counts["provider-locked"]).toBe(1);
		expect(report.counts.missing).toBe(1);
		expect(report.canSwitchWithoutLoss).toBe(false);
	});

	it("binds remote file identity to provider, transport and endpoint without exposing endpoint credentials", () => {
		const attachment: AttachmentRecord = {
			id: "att_remote",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: {
				type: "provider-file",
				provider: "openai",
				api: "openai-responses",
				endpoint: "https://api.openai.com/v1",
				fileId: "file_1",
			},
		};
		const messages: Message[] = [
			{
				role: "user",
				content: "analyze",
				attachments: [{ type: "attachment", attachmentId: attachment.id }],
				timestamp: 1,
			},
		];
		const matching = analyzeConversationPortability({
			messages,
			attachments: [attachment],
			target: model("openai", "openai-responses", "gpt-5.6", "https://api.openai.com/v1"),
		});
		expect(matching.counts.portable).toBe(1);
		expect(matching.target.baseUrl).toBe("https://api.openai.com/v1");
		const credentialReport = analyzeConversationPortability({
			messages: [],
			target: model(
				"openai",
				"openai-responses",
				"gpt-5.6",
				"https://user:password@api.openai.com/v1?api_key=must-not-leak",
			),
		});
		expect(credentialReport.target.baseUrl).toBe("https://api.openai.com/v1");

		const wrongEndpoint = analyzeConversationPortability({
			messages,
			attachments: [attachment],
			target: model("openai", "openai-responses", "gpt-5.6", "https://proxy.example.com/v1"),
		});
		expect(wrongEndpoint.counts["provider-locked"]).toBe(1);
	});
});
