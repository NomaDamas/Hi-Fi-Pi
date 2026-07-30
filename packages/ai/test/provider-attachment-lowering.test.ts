import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { sanitizeProviderPayloadForTrace } from "../src/api/attachment-lowering.ts";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { AttachmentRecord, AttachmentRegistry, Context, Model } from "../src/types.ts";

const PDF_BASE64 = "JVBERi0xLjQKJcTl8uXrCg==";
const SECOND_PDF_BASE64 = "JVBERi0xLjQKc2Vjb25kCg==";
const IMAGE_BASE64 = "iVBORw0KGgo=";
const ATTACHMENT_ID = "att_pdf";

function makeModel<TApi extends "openai-responses" | "anthropic-messages" | "google-generative-ai">(
	api: TApi,
	provider: string,
): Model<TApi> {
	return {
		id: `${provider}-test-model`,
		name: `${provider} Test Model`,
		api,
		provider,
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function makePdfRecord(): AttachmentRecord {
	return {
		id: ATTACHMENT_ID,
		filename: "paper.pdf",
		mediaType: "application/pdf",
		sizeBytes: 17,
		source: {
			type: "base64",
			data: PDF_BASE64,
		},
	};
}

function makeContext(): Context {
	const record = makePdfRecord();
	const attachmentRegistry: AttachmentRegistry = {
		resolve: (id) => (id === record.id ? record : undefined),
	};
	return {
		messages: [
			{
				role: "user",
				content: "Summarize paper.pdf",
				attachments: [{ type: "attachment", attachmentId: ATTACHMENT_ID }],
				timestamp: 1_700_000_000_000,
			},
		],
		attachmentRegistry,
	};
}

async function captureAnthropicMessages(context: Context): Promise<unknown> {
	let capturedPayload: unknown;
	const result = streamAnthropic(makeModel("anthropic-messages", "anthropic"), context, {
		apiKey: "test-key",
		cacheRetention: "none",
		onPayload: (payload) => {
			capturedPayload = payload;
			throw new Error("payload captured");
		},
	});
	await result.result();

	return (capturedPayload as { messages?: unknown } | undefined)?.messages;
}

describe("provider-native PDF attachment lowering", () => {
	it("lowers a PDF into an OpenAI Responses input_file before legacy text", () => {
		const model = makeModel("openai-responses", "openai");

		const input = convertResponsesMessages(model, makeContext(), new Set(["openai"]));

		expect(input).toEqual([
			{
				role: "user",
				content: [
					{
						type: "input_file",
						filename: "paper.pdf",
						file_data: `data:application/pdf;base64,${PDF_BASE64}`,
					},
					{ type: "input_text", text: "Summarize paper.pdf" },
				],
			},
		]);
	});

	it("lowers a PDF into an Anthropic document block before legacy text", async () => {
		expect(await captureAnthropicMessages(makeContext())).toEqual([
			{
				role: "user",
				content: [
					{
						type: "document",
						source: {
							type: "base64",
							media_type: "application/pdf",
							data: PDF_BASE64,
						},
						title: "paper.pdf",
					},
					{ type: "text", text: "Summarize paper.pdf" },
				],
			},
		]);
	});

	it("lowers a PDF into a Gemini inlineData part before legacy text", () => {
		const model = makeModel("google-generative-ai", "google");

		const contents = convertGoogleMessages(model, makeContext());

		expect(contents).toEqual([
			{
				role: "user",
				parts: [
					{
						inlineData: {
							mimeType: "application/pdf",
							data: PDF_BASE64,
						},
					},
					{ text: "Summarize paper.pdf" },
				],
			},
		]);
	});

	it("keeps attachment-free text payloads unchanged across all providers", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1_700_000_000_000 }],
		};

		expect(convertResponsesMessages(makeModel("openai-responses", "openai"), context, new Set(["openai"]))).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
		]);
		expect(convertGoogleMessages(makeModel("google-generative-ai", "google"), context)).toEqual([
			{ role: "user", parts: [{ text: "hello" }] },
		]);
		expect(await captureAnthropicMessages(context)).toEqual([{ role: "user", content: "hello" }]);
	});

	it("keeps attachment-free text and image payloads unchanged across all providers", async () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe this" },
						{ type: "image", data: IMAGE_BASE64, mimeType: "image/png" },
					],
					timestamp: 1_700_000_000_000,
				},
			],
		};

		expect(convertResponsesMessages(makeModel("openai-responses", "openai"), context, new Set(["openai"]))).toEqual([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "describe this" },
					{
						type: "input_image",
						image_url: `data:image/png;base64,${IMAGE_BASE64}`,
						detail: "auto",
					},
				],
			},
		]);
		expect(convertGoogleMessages(makeModel("google-generative-ai", "google"), context)).toEqual([
			{
				role: "user",
				parts: [{ text: "describe this" }, { inlineData: { mimeType: "image/png", data: IMAGE_BASE64 } }],
			},
		]);
		expect(await captureAnthropicMessages(context)).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "describe this" },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: IMAGE_BASE64 },
					},
				],
			},
		]);
	});

	it("preserves the original PDF bytes across all provider encodings", async () => {
		const context = makeContext();
		const expectedBytes = Buffer.from(PDF_BASE64, "base64");

		const openAiMessages = convertResponsesMessages(
			makeModel("openai-responses", "openai"),
			context,
			new Set(["openai"]),
		) as unknown as Array<{ content: Array<{ type: string; file_data?: string }> }>;
		const openAiContent = openAiMessages[0]?.content ?? [];
		const openAiFile = openAiContent.find((part) => part.type === "input_file");
		expect(openAiFile?.file_data).toBe(`data:application/pdf;base64,${PDF_BASE64}`);
		expect(Buffer.from(openAiFile?.file_data?.split(",")[1] ?? "", "base64")).toEqual(expectedBytes);

		const anthropicMessages = (await captureAnthropicMessages(context)) as Array<{
			content: Array<{ type: string; source?: { data?: string } }>;
		}>;
		const anthropicDocument = anthropicMessages[0]?.content.find((part) => part.type === "document");
		expect(Buffer.from(anthropicDocument?.source?.data ?? "", "base64")).toEqual(expectedBytes);

		const googleMessages = convertGoogleMessages(makeModel("google-generative-ai", "google"), context) as Array<{
			parts: Array<{ inlineData?: { data?: string } }>;
		}>;
		const googleDocument = googleMessages[0]?.parts.find((part) => part.inlineData);
		expect(Buffer.from(googleDocument?.inlineData?.data ?? "", "base64")).toEqual(expectedBytes);
	});

	it("preserves an attachment-only message without adding an empty text block", async () => {
		const context = makeContext();
		const message = context.messages[0];
		if (!message || message.role !== "user") throw new Error("Expected a user message");
		message.content = "";

		const openAi = convertResponsesMessages(
			makeModel("openai-responses", "openai"),
			context,
			new Set(["openai"]),
		) as unknown as Array<{ content: Array<{ type: string }> }>;
		expect(openAi[0]?.content.map((part) => part.type)).toEqual(["input_file"]);

		const anthropic = (await captureAnthropicMessages(context)) as Array<{
			content: Array<{ type: string }>;
		}>;
		expect(anthropic[0]?.content.map((part) => part.type)).toEqual(["document"]);

		const google = convertGoogleMessages(makeModel("google-generative-ai", "google"), context) as Array<{
			parts: Array<{ text?: string; inlineData?: unknown }>;
		}>;
		expect(google[0]?.parts).toHaveLength(1);
		expect(google[0]?.parts[0]?.inlineData).toBeDefined();
	});

	it("lowers multiple PDFs without dropping or swapping them", async () => {
		const first = makePdfRecord();
		const second: AttachmentRecord = {
			...makePdfRecord(),
			id: "att_second",
			filename: "second.pdf",
			source: { type: "base64", data: SECOND_PDF_BASE64 },
		};
		const records = new Map([
			[first.id, first],
			[second.id, second],
		]);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Compare the PDFs",
					attachments: [
						{ type: "attachment", attachmentId: first.id },
						{ type: "attachment", attachmentId: second.id },
					],
					timestamp: 1_700_000_000_000,
				},
			],
			attachmentRegistry: { resolve: (id) => records.get(id) },
		};

		const openAiMessages = convertResponsesMessages(
			makeModel("openai-responses", "openai"),
			context,
			new Set(["openai"]),
		) as unknown as Array<{
			content: Array<{ type: string; filename?: string; file_data?: string }>;
		}>;
		const openAiContent = openAiMessages[0]?.content ?? [];
		expect(
			openAiContent
				.filter((part) => part.type === "input_file")
				.map(({ filename, file_data }) => ({ filename, file_data })),
		).toEqual([
			{ filename: "paper.pdf", file_data: `data:application/pdf;base64,${PDF_BASE64}` },
			{ filename: "second.pdf", file_data: `data:application/pdf;base64,${SECOND_PDF_BASE64}` },
		]);

		const anthropicMessages = (await captureAnthropicMessages(context)) as Array<{
			content: Array<{ type: string; title?: string; source?: { data?: string } }>;
		}>;
		expect(
			anthropicMessages[0]?.content
				.filter((part) => part.type === "document")
				.map(({ title, source }) => ({ title, data: source?.data })),
		).toEqual([
			{ title: "paper.pdf", data: PDF_BASE64 },
			{ title: "second.pdf", data: SECOND_PDF_BASE64 },
		]);

		const googleMessages = convertGoogleMessages(makeModel("google-generative-ai", "google"), context) as Array<{
			parts: Array<{ inlineData?: { data: string } }>;
		}>;
		expect(googleMessages[0]?.parts.filter((part) => part.inlineData).map((part) => part.inlineData?.data)).toEqual([
			PDF_BASE64,
			SECOND_PDF_BASE64,
		]);
	});

	it("resolves local PDF bytes through the attachment registry", () => {
		const local: AttachmentRecord = {
			id: "att_local",
			filename: "local.pdf",
			mediaType: "application/pdf",
			source: { type: "path", path: "/fixtures/local.pdf" },
		};
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Analyze local.pdf",
					attachments: [{ type: "attachment", attachmentId: local.id }],
					timestamp: 1_700_000_000_000,
				},
			],
			attachmentRegistry: {
				resolve: (id) => (id === local.id ? local : undefined),
				read: () => Buffer.from(PDF_BASE64, "base64"),
			},
		};

		expect(convertResponsesMessages(makeModel("openai-responses", "openai"), context, new Set(["openai"]))).toEqual([
			{
				role: "user",
				content: [
					{
						type: "input_file",
						filename: "local.pdf",
						file_data: `data:application/pdf;base64,${PDF_BASE64}`,
					},
					{ type: "input_text", text: "Analyze local.pdf" },
				],
			},
		]);
	});

	it("lowers PDF URLs to each provider's native URL representation", async () => {
		const remoteUrl = "https://example.com/paper.pdf";
		const record: AttachmentRecord = {
			id: "att_url",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "url", url: remoteUrl },
		};
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Analyze",
					attachments: [{ type: "attachment", attachmentId: record.id }],
					timestamp: 1_700_000_000_000,
				},
			],
			attachmentRegistry: { resolve: () => record },
		};

		const openAi = convertResponsesMessages(
			makeModel("openai-responses", "openai"),
			context,
			new Set(["openai"]),
		) as unknown as Array<{ content: Array<unknown> }>;
		expect(openAi[0]?.content[0]).toEqual({ type: "input_file", file_url: remoteUrl });

		const anthropic = (await captureAnthropicMessages(context)) as Array<{ content: Array<unknown> }>;
		expect(anthropic[0]?.content[0]).toEqual({
			type: "document",
			source: { type: "url", url: remoteUrl },
			title: "paper.pdf",
		});

		const google = convertGoogleMessages(makeModel("google-generative-ai", "google"), context) as Array<{
			parts: Array<unknown>;
		}>;
		expect(google[0]?.parts[0]).toEqual({
			fileData: { mimeType: "application/pdf", fileUri: remoteUrl },
		});
	});

	it("reuses a matching provider remote file reference", () => {
		const record: AttachmentRecord = {
			...makePdfRecord(),
			remotes: {
				openai: {
					provider: "openai",
					api: "openai-responses",
					fileId: "file_123",
					uploadedAt: Date.now(),
				},
			},
		};
		const context: Context = {
			...makeContext(),
			attachmentRegistry: { resolve: () => record },
		};

		const openAi = convertResponsesMessages(
			makeModel("openai-responses", "openai"),
			context,
			new Set(["openai"]),
		) as unknown as Array<{ content: Array<unknown> }>;
		expect(openAi[0]?.content[0]).toEqual({ type: "input_file", file_id: "file_123" });
	});

	it("rejects a provider-file source owned by another provider", () => {
		const record: AttachmentRecord = {
			id: "att_foreign",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "provider-file", provider: "openai", fileId: "file_123" },
		};
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Analyze",
					attachments: [{ type: "attachment", attachmentId: record.id }],
					timestamp: 1_700_000_000_000,
				},
			],
			attachmentRegistry: { resolve: () => record },
		};

		expect(() => convertGoogleMessages(makeModel("google-generative-ai", "google"), context)).toThrow(
			/provider file belongs to openai/i,
		);
	});

	it("sanitizes inline attachment bytes from provider request traces", () => {
		expect(
			sanitizeProviderPayloadForTrace({
				input: [
					{
						type: "input_file",
						filename: "paper.pdf",
						file_data: `data:application/pdf;base64,${PDF_BASE64}`,
					},
				],
				model: "test-model",
			}),
		).toEqual({
			input: [{ type: "input_file", filename: "paper.pdf", file_data: "[redacted 52 chars]" }],
			model: "test-model",
		});
	});

	it("fails clearly when an attachment reference is missing from the registry", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Analyze the attachment",
					attachments: [{ type: "attachment", attachmentId: "missing" }],
					timestamp: 1_700_000_000_000,
				},
			],
			attachmentRegistry: {
				resolve: () => undefined,
			},
		};

		expect(() =>
			convertResponsesMessages(makeModel("openai-responses", "openai"), context, new Set(["openai"])),
		).toThrow("Attachment not found: missing");
	});

	it("fails clearly when the attachment registry is unavailable", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Analyze the attachment",
					attachments: [{ type: "attachment", attachmentId: ATTACHMENT_ID }],
					timestamp: 1_700_000_000_000,
				},
			],
		};

		expect(() =>
			convertResponsesMessages(makeModel("openai-responses", "openai"), context, new Set(["openai"])),
		).toThrow("Attachment registry is required for messages with attachments");
	});

	it("fails before request construction when a local source cannot be read", () => {
		const record: AttachmentRecord = {
			id: "att_missing_file",
			filename: "missing.pdf",
			mediaType: "application/pdf",
			source: { type: "path", path: "/missing.pdf" },
		};
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Analyze",
					attachments: [{ type: "attachment", attachmentId: record.id }],
					timestamp: 1_700_000_000_000,
				},
			],
			attachmentRegistry: {
				resolve: () => record,
				read: () => {
					throw new Error("ENOENT");
				},
			},
		};

		expect(() =>
			convertResponsesMessages(makeModel("openai-responses", "openai"), context, new Set(["openai"])),
		).toThrow(/Attachment source is unavailable.*ENOENT/);
	});

	it("rejects unsupported media before provider request construction", () => {
		const video: AttachmentRecord = {
			id: "att_video",
			filename: "demo.mp4",
			mediaType: "video/mp4",
			source: { type: "base64", data: "AAAA" },
		};
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "Analyze demo.mp4",
					attachments: [{ type: "attachment", attachmentId: video.id }],
					timestamp: 1_700_000_000_000,
				},
			],
			attachmentRegistry: {
				resolve: (id) => (id === video.id ? video : undefined),
			},
		};

		expect(() => convertGoogleMessages(makeModel("google-generative-ai", "google"), context)).toThrow(
			/google.*google-generative-ai.*video\/mp4/i,
		);
	});
});
