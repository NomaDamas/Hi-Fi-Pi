import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { AttachmentRecord, Context, Model } from "../src/types.ts";

const PDF_BASE64 = "JVBERi0xLjQKJcTl8uXrCg==";

function makeModel<TApi extends "openai-responses" | "anthropic-messages" | "google-generative-ai">(
	api: TApi,
	provider: string,
	id = `${provider}-tool-attachment-model`,
): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl:
			api === "openai-responses"
				? "https://api.openai.com/v1"
				: api === "anthropic-messages"
					? "https://api.anthropic.com"
					: "https://generativelanguage.googleapis.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function makeContext(
	model: Model<string>,
	source: AttachmentRecord["source"] = { type: "base64", data: PDF_BASE64 },
): Context {
	const attachment: AttachmentRecord = {
		id: "att_tool_pdf",
		filename: "tool-output.pdf",
		mediaType: "application/pdf",
		sizeBytes: 17,
		source,
	};
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_123", name: "make_report", arguments: {} }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call_123",
				toolName: "make_report",
				content: [{ type: "text", text: "report generated" }],
				attachments: [{ type: "attachment", attachmentId: attachment.id }],
				isError: false,
				timestamp: 2,
			},
		],
		attachmentRegistry: { resolve: (id) => (id === attachment.id ? attachment : undefined) },
	};
}

async function captureAnthropicMessages(model: Model<"anthropic-messages">, context: Context): Promise<unknown> {
	let payload: unknown;
	const stream = streamAnthropic(model, context, {
		apiKey: "test-key",
		cacheRetention: "none",
		onPayload: (nextPayload) => {
			payload = nextPayload;
			throw new Error("captured");
		},
	});
	await stream.result();
	return (payload as { messages: unknown }).messages;
}

describe("tool-result native PDF attachment lowering", () => {
	it("uses OpenAI Responses function_call_output file content", () => {
		const model = makeModel("openai-responses", "openai");

		expect(convertResponsesMessages(model, makeContext(model), new Set(["openai"]))).toEqual([
			{ type: "function_call", id: undefined, call_id: "call_123", name: "make_report", arguments: "{}" },
			{
				type: "function_call_output",
				call_id: "call_123",
				output: [
					{ type: "input_text", text: "report generated" },
					{
						type: "input_file",
						filename: "tool-output.pdf",
						file_data: `data:application/pdf;base64,${PDF_BASE64}`,
					},
				],
			},
		]);
	});

	it("uses an Anthropic document inside tool_result content", async () => {
		const model = makeModel("anthropic-messages", "anthropic");

		expect(await captureAnthropicMessages(model, makeContext(model))).toEqual([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_123", name: "make_report", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_123",
						content: [
							{ type: "text", text: "report generated" },
							{
								type: "document",
								source: { type: "base64", media_type: "application/pdf", data: PDF_BASE64 },
								title: "tool-output.pdf",
							},
						],
						is_error: false,
					},
				],
			},
		]);
	});

	it("uses Gemini 3 multimodal functionResponse parts", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-3-pro");

		expect(convertGoogleMessages(model, makeContext(model))).toEqual([
			{ role: "model", parts: [{ functionCall: { name: "make_report", args: {} } }] },
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							name: "make_report",
							response: { output: "report generated" },
							parts: [
								{
									inlineData: {
										mimeType: "application/pdf",
										data: PDF_BASE64,
										displayName: "tool-output.pdf",
									},
								},
							],
						},
					},
				],
			},
		]);
	});

	it("rejects tool-result PDF attachments for pre-Gemini-3 models", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-2.5-pro");

		expect(() => convertGoogleMessages(model, makeContext(model))).toThrow(/Gemini 3.*tool-result PDF/i);
	});

	it("reads a local PDF as bytes without UTF-8 conversion before OpenAI lowering", () => {
		const model = makeModel("openai-responses", "openai");
		const context = makeContext(model, { type: "path", path: "/fixtures/tool-output.pdf" });
		const originalBytes = Uint8Array.from(atob(PDF_BASE64), (character) => character.charCodeAt(0));
		const registry = context.attachmentRegistry;
		context.attachmentRegistry = {
			resolve: (id) => registry?.resolve(id),
			read: () => originalBytes,
		};

		const payload = convertResponsesMessages(model, context, new Set(["openai"]));
		expect(payload[1]).toMatchObject({
			type: "function_call_output",
			output: [
				{ type: "input_text", text: "report generated" },
				{ type: "input_file", file_data: `data:application/pdf;base64,${PDF_BASE64}` },
			],
		});
	});

	it("reuses same-provider file IDs and rejects cross-provider file IDs", () => {
		const model = makeModel("openai-responses", "openai");
		const sameProvider = makeContext(model, {
			type: "provider-file",
			provider: "openai",
			fileId: "file_tool_report",
		});
		expect(convertResponsesMessages(model, sameProvider, new Set(["openai"]))[1]).toMatchObject({
			type: "function_call_output",
			output: [
				{ type: "input_text", text: "report generated" },
				{ type: "input_file", file_id: "file_tool_report" },
			],
		});

		const wrongProvider = makeContext(model, {
			type: "provider-file",
			provider: "anthropic",
			fileId: "file_tool_report",
		});
		expect(() => convertResponsesMessages(model, wrongProvider, new Set(["openai"]))).toThrow(
			/provider file belongs to anthropic/i,
		);
	});

	it("rejects missing registries and unsupported tool-result media before request construction", () => {
		const model = makeModel("openai-responses", "openai");
		const missingRegistry = makeContext(model);
		delete missingRegistry.attachmentRegistry;
		expect(() => convertResponsesMessages(model, missingRegistry, new Set(["openai"]))).toThrow(
			/attachment registry is required/i,
		);

		const unsupported = makeContext(model);
		const registry = unsupported.attachmentRegistry;
		unsupported.attachmentRegistry = {
			resolve: (id) => {
				const record = registry?.resolve(id);
				return record ? { ...record, mediaType: "video/mp4" } : undefined;
			},
		};
		expect(() => convertResponsesMessages(model, unsupported, new Set(["openai"]))).toThrow(
			/does not support video\/mp4 native input/i,
		);
	});

	it("keeps legacy text-only tool-result payloads unchanged", async () => {
		const openai = makeModel("openai-responses", "openai");
		expect(convertResponsesMessages(openai, makeContextWithoutAttachments(openai), new Set(["openai"]))).toEqual([
			{ type: "function_call", id: undefined, call_id: "call_123", name: "make_report", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_123", output: "report generated" },
		]);

		const anthropic = makeModel("anthropic-messages", "anthropic");
		expect(await captureAnthropicMessages(anthropic, makeContextWithoutAttachments(anthropic))).toEqual([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_123", name: "make_report", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_123",
						content: "report generated",
						is_error: false,
					},
				],
			},
		]);

		const google = makeModel("google-generative-ai", "google", "gemini-3-pro");
		expect(convertGoogleMessages(google, makeContextWithoutAttachments(google))).toEqual([
			{ role: "model", parts: [{ functionCall: { name: "make_report", args: {} } }] },
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							name: "make_report",
							response: { output: "report generated" },
						},
					},
				],
			},
		]);
	});
});

function makeContextWithoutAttachments(model: Model<string>): Context {
	const context = makeContext(model);
	const result = context.messages[1];
	if (result?.role !== "toolResult") throw new Error("tool result fixture missing");
	delete result.attachments;
	delete context.attachmentRegistry;
	return context;
}
