import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	class BedrockRuntimeClient {
		middlewareStack = { add: vi.fn() };
		send(): Promise<never> {
			return Promise.reject(new Error("network should not execute"));
		}
	}
	class ConverseStreamCommand {
		readonly input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}
	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "1h" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { resolveNativeInputCapability } from "../src/native-input-capabilities.ts";
import type { AttachmentRecord, Context, Model, ProviderTraceEvent } from "../src/types.ts";

const model: Model<"bedrock-converse-stream"> = {
	provider: "amazon-bedrock",
	api: "bedrock-converse-stream",
	id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
	name: "Claude Sonnet 4.5",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

async function capturePayload(context: Context, targetModel = model): Promise<unknown> {
	let captured: unknown;
	await streamBedrock(targetModel, context, {
		cacheRetention: "none",
		env: { AWS_BEDROCK_SKIP_AUTH: "1" },
		onPayload: (payload) => {
			captured = payload;
			throw new Error("captured");
		},
	}).result();
	return captured;
}

function contextWith(attachment: AttachmentRecord, text = "analyze"): Context {
	return {
		messages: [
			{
				role: "user",
				content: text,
				attachments: [{ type: "attachment", attachmentId: attachment.id }],
				timestamp: 1,
			},
		],
		attachmentRegistry: { resolve: (id) => (id === attachment.id ? attachment : undefined) },
	};
}

describe("Bedrock official native input contract", () => {
	it("exposes model-family and official-endpoint scoped capabilities", () => {
		expect(resolveNativeInputCapability(model, "application/pdf", "inline")).toMatchObject({
			supported: true,
			endpointProfile: "bedrock-official",
			wireKind: "document",
		});
		const nova = { ...model, id: "amazon.nova-pro-v1:0", name: "Nova Pro" };
		expect(resolveNativeInputCapability(nova, "video/mp4", "cloud-uri")).toMatchObject({
			supported: true,
			wireKind: "video",
		});
		expect(resolveNativeInputCapability(model, "video/mp4", "inline").supported).toBe(false);
		expect(
			resolveNativeInputCapability({ ...model, baseUrl: "https://proxy.example.com" }, "application/pdf", "inline")
				.supported,
		).toBe(false);
	});

	it("lowers a PDF to exact SDK bytes with its required accompanying text", async () => {
		const attachment: AttachmentRecord = {
			id: "att_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "base64", data: "JVBERi0xLjQ=" },
		};
		const payload = (await capturePayload(contextWith(attachment, ""))) as {
			messages: Array<{ content: Array<{ text?: string; document?: { source: { bytes: Uint8Array } } }> }>;
		};
		expect(payload.messages[0].content[0]).toEqual({ text: "<empty>" });
		expect(payload.messages[0].content[1]).toMatchObject({
			document: { format: "pdf", name: "paper" },
		});
		expect([...payload.messages[0].content[1].document!.source.bytes]).toEqual([
			...new TextEncoder().encode("%PDF-1.4"),
		]);
	});

	it("lowers Nova video to an S3 source and rejects non-S3 cloud URIs", async () => {
		const nova = { ...model, id: "amazon.nova-pro-v1:0", name: "Nova Pro" };
		const attachment: AttachmentRecord = {
			id: "att_video",
			filename: "demo.mp4",
			mediaType: "video/mp4",
			source: { type: "cloud-uri", uri: "s3://bucket/demo.mp4", provider: "amazon-bedrock" },
		};
		const payload = (await capturePayload(contextWith(attachment), nova)) as {
			messages: Array<{ content: Array<Record<string, unknown>> }>;
		};
		expect(payload.messages[0].content[1]).toEqual({
			video: { format: "mp4", source: { s3Location: { uri: "s3://bucket/demo.mp4" } } },
		});

		const invalid = { ...attachment, source: { type: "cloud-uri", uri: "gs://bucket/demo.mp4" } } as AttachmentRecord;
		const result = await streamBedrock(nova, contextWith(invalid), {
			cacheRetention: "none",
			env: { AWS_BEDROCK_SKIP_AUTH: "1" },
		}).result();
		expect(result.errorMessage).toContain("require an s3:// cloud URI");
	});

	it("redacts inline bytes and credentials from provider traces", async () => {
		const attachment: AttachmentRecord = {
			id: "att_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "base64", data: "JVBERi0xLjQ=" },
		};
		const events: ProviderTraceEvent[] = [];
		await streamBedrock(model, contextWith(attachment), {
			cacheRetention: "none",
			env: { AWS_BEDROCK_SKIP_AUTH: "1" },
			headers: { Authorization: "secret", "x-amz-security-token": "signed-secret" },
			onTrace: (event) => {
				events.push(event);
			},
			onPayload: (payload) => payload,
		}).result();
		const serialized = JSON.stringify(events);
		expect(serialized).toContain("redacted inline bytes");
		expect(serialized).not.toContain("JVBERi0xLjQ");
		expect(serialized).not.toContain("signed-secret");
		expect(serialized).not.toContain('"secret"');
	});
});
