import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { convertMessages as convertOpenAIChatMessages } from "../src/api/openai-completions.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Api, AttachmentRecord, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

const compat: Omit<Required<OpenAICompletionsCompat>, "deferredToolsMode"> & {
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
} = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
};

function model<TApi extends Api>(provider: string, api: TApi, id: string): Model<TApi> {
	return {
		provider,
		api,
		id,
		name: id,
		baseUrl:
			provider === "openai"
				? "https://api.openai.com/v1"
				: provider === "anthropic"
					? "https://api.anthropic.com"
					: "https://generativelanguage.googleapis.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function context(record: AttachmentRecord, text = "Inspect the original file."): Context {
	return {
		messages: [
			{
				role: "user",
				content: text,
				attachments: [{ type: "attachment", attachmentId: record.id }],
				timestamp: 1,
			},
		],
		attachmentRegistry: { resolve: (id) => (id === record.id ? record : undefined) },
	};
}

function inlineRecord(filename: string, mediaType: string, bytes: Uint8Array): AttachmentRecord {
	return {
		id: `att_${filename}`,
		filename,
		mediaType,
		sizeBytes: bytes.byteLength,
		source: { type: "base64", data: Buffer.from(bytes).toString("base64") },
	};
}

async function captureAnthropic(contextValue: Context): Promise<unknown> {
	let payload: unknown;
	const result = streamAnthropic(model("anthropic", "anthropic-messages", "claude-sonnet-4-6"), contextValue, {
		apiKey: "test",
		cacheRetention: "none",
		onPayload: (value) => {
			payload = value;
			throw new Error("captured");
		},
	});
	await result.result();
	return (payload as { messages?: unknown })?.messages;
}

describe("native Office, data, text, audio and video transports", () => {
	it.each([
		["paper.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
		["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
		["data.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
		["rows.csv", "text/csv"],
		["README.md", "text/markdown"],
		["main.ts", "text/x-typescript"],
	])("sends %s through OpenAI input_file without altering bytes", (filename, mediaType) => {
		const bytes = Uint8Array.from([0, 1, 2, 0xfe, 0xff, 10]);
		const record = inlineRecord(filename, mediaType, bytes);
		const input = convertResponsesMessages(
			model("openai", "openai-responses", "gpt-5.6"),
			context(record),
			new Set(["openai"]),
		) as unknown as Array<{ content: Array<{ type: string; file_data?: string }> }>;
		const fileData = input[0]?.content.find((part) => part.type === "input_file")?.file_data;
		expect(fileData).toBe(`data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`);
		expect(Buffer.from(fileData?.split(",")[1] ?? "", "base64")).toEqual(Buffer.from(bytes));
	});

	it("sends an explicit UTF-8 text document as an Anthropic text document block", async () => {
		const text = "Provider-native plain text.\n한글도 그대로 보존합니다.\n";
		const record = inlineRecord("notes.txt", "text/plain", Buffer.from(text));
		expect(await captureAnthropic(context(record))).toEqual([
			{
				role: "user",
				content: [
					{
						type: "document",
						source: { type: "text", media_type: "text/plain", data: text },
						title: "notes.txt",
					},
					{ type: "text", text: "Inspect the original file." },
				],
			},
		]);
	});

	it.each([
		["meeting.wav", "audio/wav"],
		["demo.mp4", "video/mp4"],
	])("passes %s to Gemini inlineData without preprocessing", (filename, mediaType) => {
		const bytes = Uint8Array.from([0, 255, 18, 52, 86]);
		const record = inlineRecord(filename, mediaType, bytes);
		const contents = convertGoogleMessages(
			model("google", "google-generative-ai", "gemini-2.5-pro"),
			context(record),
		) as Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>;
		expect(contents[0]?.parts[0]?.inlineData).toEqual({
			mimeType: mediaType,
			data: Buffer.from(bytes).toString("base64"),
		});
		expect(Buffer.from(contents[0]?.parts[0]?.inlineData?.data ?? "", "base64")).toEqual(Buffer.from(bytes));
	});

	it("passes a GCS video URI to Gemini fileData without fetching it", () => {
		const record: AttachmentRecord = {
			id: "att_video",
			filename: "demo.mp4",
			mediaType: "video/mp4",
			source: { type: "cloud-uri", uri: "gs://bucket/demo.mp4", provider: "google" },
		};
		const contents = convertGoogleMessages(
			model("google", "google-generative-ai", "gemini-2.5-pro"),
			context(record),
		) as Array<{ parts: Array<{ fileData?: { mimeType: string; fileUri: string } }> }>;
		expect(contents[0]?.parts[0]?.fileData).toEqual({ mimeType: "video/mp4", fileUri: "gs://bucket/demo.mp4" });
	});

	it("uses OpenAI Chat Completions input_audio only for an audio model", () => {
		const bytes = Buffer.from("RIFF native audio bytes", "binary");
		const record = inlineRecord("meeting.wav", "audio/wav", bytes);
		const messages = convertOpenAIChatMessages(
			model("openai", "openai-completions", "gpt-audio-1.5"),
			context(record, "What is in this recording?"),
			compat,
		) as Array<{ content: Array<{ type: string; input_audio?: { data: string; format: string } }> }>;
		expect(messages[0]?.content[0]).toEqual({
			type: "input_audio",
			input_audio: { data: bytes.toString("base64"), format: "wav" },
		});
		expect(messages[0]?.content[1]).toEqual({ type: "text", text: "What is in this recording?" });
	});

	it("rejects Anthropic video and OpenAI Responses audio before any network request", async () => {
		const video = inlineRecord("demo.mp4", "video/mp4", Buffer.from("video"));
		let networkCalled = false;
		const anthropicResult = streamAnthropic(
			model("anthropic", "anthropic-messages", "claude-sonnet-4-6"),
			context(video),
			{
				apiKey: "test",
				cacheRetention: "none",
				fetch: async () => {
					networkCalled = true;
					return new Response(null, { status: 500 });
				},
			},
		);
		const anthropicError = await anthropicResult.result();
		expect(anthropicError.stopReason).toBe("error");
		expect(anthropicError.errorMessage).toMatch(/does not support video\/mp4 native input/i);
		expect(networkCalled).toBe(false);
		const audio = inlineRecord("meeting.wav", "audio/wav", Buffer.from("audio"));
		expect(() =>
			convertResponsesMessages(model("openai", "openai-responses", "gpt-5.6"), context(audio), new Set(["openai"])),
		).toThrow(/does not support audio\/wav native input/i);
	});
});
