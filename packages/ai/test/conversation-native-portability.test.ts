import { describe, expect, it } from "vitest";
import { analyzeConversationPortability, projectConversationForTarget } from "../src/portability.ts";
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
		const projected = projectConversationForTarget({
			messages: [legacy],
			target: model("openai", "openai-responses", "gpt-5.6", "https://api.openai.com/v1"),
		});
		expect(JSON.stringify(projected.messages[0])).toBe(JSON.stringify(legacy));
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
				endpoint: "https://user:password@api.openai.com/v1?token=must-not-leak",
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
		expect(wrongEndpoint.items[0]?.reason).not.toMatch(/password|must-not-leak/);
	});

	it("projects only explicitly approved stable attachment identities without mutating history", () => {
		const target = model("custom", "openai-responses", "target", "https://proxy.example/v1");
		target.nativeInputs = {
			profile: "test-files",
			capabilities: [
				{
					id: "pdf",
					supported: true,
					mediaTypes: ["application/pdf"],
					sources: ["inline"],
					wireKinds: { inline: "input_file" },
					provenance: "configured",
				},
			],
		};
		const attachments: AttachmentRecord[] = [
			{
				id: "att_pdf",
				filename: "paper.pdf",
				mediaType: "application/pdf",
				source: { type: "base64", data: "JVBERg==" },
			},
			{
				id: "att_video",
				filename: "demo.mp4",
				mediaType: "video/mp4",
				source: { type: "base64", data: "AAAA" },
			},
		];
		const messages: Message[] = [
			{
				role: "user",
				content: "compare",
				attachments: attachments.map((item) => ({ type: "attachment", attachmentId: item.id })),
				timestamp: 1,
			},
		];
		const before = structuredClone(messages);
		const unconfirmed = projectConversationForTarget({ messages, attachments, target });
		expect(unconfirmed.unapprovedItemIds).toEqual(["attachment:att_video"]);
		expect(unconfirmed.messages).toEqual(messages);

		const confirmed = projectConversationForTarget({
			messages,
			attachments,
			target,
			approvedItemIds: ["attachment:att_video"],
		});
		expect(confirmed.activeAttachmentIds).toEqual(["att_pdf"]);
		expect(confirmed.suspendedAttachmentIds).toEqual(["att_video"]);
		expect(confirmed.messages[0]).toMatchObject({
			content: [
				{ type: "text", text: "compare" },
				{
					type: "text",
					text: "(video/mp4 attachment omitted: target model does not support video/mp4)",
				},
			],
			attachments: [{ type: "attachment", attachmentId: "att_pdf" }],
		});
		expect(messages).toEqual(before);
	});

	it("collapses suspended attachment disclosures into one safe user content block", () => {
		const target = model("custom", "openai-responses", "target", "https://proxy.example/v1");
		const attachments: AttachmentRecord[] = [
			{
				id: "att_video",
				filename: "private-demo.mp4",
				mediaType: "video/mp4",
				source: { type: "path", path: "/secret/project/private-demo.mp4" },
			},
			{
				id: "att_video_copy",
				filename: "private-demo-copy.mp4",
				mediaType: "video/mp4",
				source: { type: "path", path: "/secret/project/private-demo-copy.mp4" },
			},
			{
				id: "att_audio",
				filename: "private-meeting.wav",
				mediaType: "audio/wav",
				source: { type: "base64", data: "c2VjcmV0LWJ5dGVz" },
			},
			{
				id: "att_remote",
				filename: "private-report.pdf",
				mediaType: "application/pdf",
				source: {
					type: "provider-file",
					provider: "other-provider",
					api: "openai-responses",
					endpoint: "https://secret-source.example/v1",
					fileId: "file_secret",
				},
			},
		];
		const projected = projectConversationForTarget({
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "compare the files" }],
					attachments: attachments.map((item) => ({ type: "attachment", attachmentId: item.id })),
					timestamp: 1,
				},
			],
			attachments,
			target,
			sourceAvailable: (item) => item.id !== "att_video" && item.id !== "att_video_copy",
			approvedItemIds: attachments.map((item) => `attachment:${item.id}`),
		});
		const message = projected.messages[0];
		expect(message?.role).toBe("user");
		if (message?.role !== "user" || typeof message.content === "string")
			throw new Error("projected user content missing");
		expect(message.content).toHaveLength(2);
		const disclosure = message.content[1];
		expect(disclosure?.type).toBe("text");
		if (disclosure?.type !== "text") throw new Error("omission disclosure missing");
		expect(disclosure.text.match(/attachment omitted/g)).toHaveLength(3);
		expect(disclosure.text.match(/video\/mp4/g)).toHaveLength(1);
		expect(disclosure.text).toContain("video/mp4");
		expect(disclosure.text).toContain("audio/wav");
		expect(disclosure.text).toContain("application/pdf");
		expect(disclosure.text).toContain("source is unavailable");
		expect(disclosure.text).toContain("target model does not support audio/wav");
		expect(disclosure.text).toContain("source is bound to another provider transport");
		expect(disclosure.text).not.toMatch(
			/\/secret|private-demo|private-meeting|private-report|c2VjcmV0LWJ5dGVz|secret-source|file_secret/,
		);
	});

	it("adds the same safe disclosure to suspended tool-result attachments", () => {
		const target = model("custom", "openai-responses", "target", "https://proxy.example/v1");
		const attachment: AttachmentRecord = {
			id: "att_tool_video",
			filename: "generated.mp4",
			mediaType: "video/mp4",
			source: { type: "base64", data: "Z2VuZXJhdGVkLWJ5dGVz" },
		};
		const projected = projectConversationForTarget({
			messages: [
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "make_video",
					content: [{ type: "text", text: "created" }],
					attachments: [{ type: "attachment", attachmentId: attachment.id }],
					isError: false,
					timestamp: 1,
				},
			],
			attachments: [attachment],
			target,
			approvedItemIds: [`attachment:${attachment.id}`],
		});
		const message = projected.messages[0];
		expect(message?.role).toBe("toolResult");
		if (message?.role !== "toolResult") throw new Error("projected tool result missing");
		expect(message.attachments).toBeUndefined();
		expect(message.content).toEqual([
			{ type: "text", text: "created" },
			{
				type: "text",
				text: "(video/mp4 attachment omitted: target model does not support video/mp4)",
			},
		]);
		expect(JSON.stringify(message)).not.toMatch(/generated\.mp4|Z2VuZXJhdGVkLWJ5dGVz/);
	});

	it("keeps stable projection identities when message indexes shift", () => {
		const native = assistant({
			nativeParts: [
				{
					type: "provider-native",
					provider: "anthropic",
					api: "anthropic-messages",
					kind: "server_state",
					payload: { opaque: true },
					stateId: "state_1",
				},
			],
		});
		const target = model("openai", "openai-responses", "gpt-5.6", "https://api.openai.com/v1");
		const first = analyzeConversationPortability({ messages: [native], target });
		const shifted = analyzeConversationPortability({
			messages: [{ role: "user", content: "prefix", timestamp: 0 }, native],
			target,
		});

		expect(first.items[0].id).not.toBe(shifted.items[0].id);
		expect(first.items[0].stableId).toBe(shifted.items[0].stableId);
	});

	it("does not make same-millisecond identity-less native state projectable", () => {
		const messages: Message[] = [
			assistant({
				timestamp: 1,
				nativeParts: [{ type: "provider-native", provider: "anthropic", kind: "opaque-a", payload: { value: 1 } }],
			}),
			assistant({
				timestamp: 1,
				nativeParts: [{ type: "provider-native", provider: "anthropic", kind: "opaque-b", payload: { value: 2 } }],
			}),
		];
		const target = model("openai", "openai-responses", "gpt-5.6", "https://api.openai.com/v1");
		const report = analyzeConversationPortability({ messages, target });

		expect(report.items).toHaveLength(2);
		expect(report.items.every((item) => item.projectable === false)).toBe(true);
		const projected = projectConversationForTarget({
			messages,
			target,
			approvedItemIds: report.items.map((item) => item.stableId),
		});
		expect(projected.suspendedItemIds).toEqual([]);
		expect(projected.unapprovedItemIds).toHaveLength(2);
		expect(projected.messages).toEqual(messages);
	});
});
