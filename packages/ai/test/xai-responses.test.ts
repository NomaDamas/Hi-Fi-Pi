import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIResponsesOptions } from "../src/api/openai-responses.ts";
import { resolveAttachmentUploadBackend } from "../src/attachment-lifecycle.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { resolveNativeInputCapability } from "../src/native-input-capabilities.ts";
import { getProviderOptionDefinitions } from "../src/provider-options.ts";
import { XAI_MODELS } from "../src/providers/xai.models.ts";
import { xaiProvider } from "../src/providers/xai.ts";
import type { AttachmentRecord, Context, Model } from "../src/types.ts";

type CapturedRequest = {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
};

function completedResponse(): Response {
	const event = {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_xai_test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureRequest(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions,
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		captured = {
			url: request.url,
			headers: request.headers,
			body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
		};
		return completedResponse();
	});

	const result = await xaiProvider().stream(model, context, options).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(captured).toBeDefined();
	return captured!;
}

describe("xAI Responses provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("excludes retired and redundant models from the built-in catalog", () => {
		for (const modelId of [
			"grok-3",
			"grok-3-fast",
			"grok-4.20-0309-non-reasoning",
			"grok-4.20-0309-reasoning",
			"grok-code-fast-1",
		]) {
			expect(Object.keys(XAI_MODELS)).not.toContain(modelId);
		}
	});

	it("uses Responses with low/medium/high efforts only for Grok 4.5", () => {
		expect(XAI_MODELS["grok-4.5"].api).toBe("openai-responses");
		expect(getSupportedThinkingLevels(XAI_MODELS["grok-4.5"])).toEqual(["low", "medium", "high"]);
		expect(XAI_MODELS["grok-4.3"].api).toBe("openai-completions");
	});

	it("uses /responses with bearer auth and xAI-compatible request fields", async () => {
		const captured = await captureRequest(
			XAI_MODELS["grok-4.5"],
			{
				systemPrompt: "You are a careful coding assistant.",
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{
				apiKey: "xai-test-token",
				sessionId: "pi-session-123",
				cacheRetention: "long",
				reasoningEffort: "medium",
			},
		);

		expect(captured.url).toBe("https://api.x.ai/v1/responses");
		expect(captured.headers.get("authorization")).toBe("Bearer xai-test-token");
		expect(captured.headers.get("session_id")).toBe("pi-session-123");
		expect(captured.body).toMatchObject({
			model: "grok-4.5",
			store: false,
			stream: true,
			prompt_cache_key: "pi-session-123",
			reasoning: { effort: "medium" },
			include: ["reasoning.encrypted_content"],
		});
		expect(captured.body).not.toHaveProperty("prompt_cache_retention");
		expect(captured.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "developer",
					content: "You are a careful coding assistant.",
				}),
			]),
		);
	});

	it("scopes official file capabilities and controls to api.x.ai", () => {
		const model = XAI_MODELS["grok-4.5"];
		expect(resolveNativeInputCapability(model, "application/pdf", "url")).toMatchObject({
			supported: true,
			endpointProfile: "xai-official",
			wireKind: "input_file",
			provenance: "official-default",
		});
		expect(resolveNativeInputCapability(model, "application/pdf", "inline").supported).toBe(false);
		expect(getProviderOptionDefinitions(model).map((definition) => definition.key)).toEqual([
			"xai.responses.built_in_tools",
		]);

		const proxy = { ...model, baseUrl: "https://proxy.example.com/v1" };
		expect(resolveNativeInputCapability(proxy, "application/pdf", "url").supported).toBe(false);
		expect(getProviderOptionDefinitions(proxy)).toEqual([]);
	});

	it("lowers only documented URL and uploaded-file references", async () => {
		const attachment: AttachmentRecord = {
			id: "att_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "url", url: "https://example.com/paper.pdf" },
		};
		const captured = await captureRequest(
			XAI_MODELS["grok-4.5"],
			{
				messages: [
					{
						role: "user",
						content: "analyze",
						attachments: [{ type: "attachment", attachmentId: attachment.id }],
						timestamp: 1,
					},
				],
				attachmentRegistry: { resolve: () => attachment },
			},
			{
				apiKey: "xai-test-token",
				providerOptions: {
					"xai.responses.built_in_tools": [{ type: "web_search" }, { type: "x_search" }],
				},
			},
		);
		const input = captured.body.input as Array<{ content?: Array<Record<string, unknown>> }>;
		expect(input[0]?.content?.[0]).toEqual({
			type: "input_file",
			file_url: "https://example.com/paper.pdf",
		});
		expect(captured.body.tools).toEqual([{ type: "web_search" }, { type: "x_search" }]);
	});

	it("provides an endpoint-scoped xAI Files API backend", async () => {
		const model = XAI_MODELS["grok-4.5"];
		const backend = resolveAttachmentUploadBackend(model);
		expect(backend?.id).toBe("xai-files-v1");
		let request: Request | undefined;
		const reference = await backend!.upload({
			model,
			attachment: {
				id: "att_pdf",
				filename: "paper.pdf",
				mediaType: "application/pdf",
				source: { type: "base64", data: "JVBERg==" },
			},
			bytes: new TextEncoder().encode("%PDF"),
			sha256: "sha256",
			apiKey: "xai-test-token",
			fetch: async (input, init) => {
				request = new Request(input, init);
				return new Response(JSON.stringify({ id: "file_xai", created_at: 1, filename: "paper.pdf", bytes: 4 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
		expect(request?.url).toBe("https://api.x.ai/v1/files");
		expect(request?.headers.get("authorization")).toBe("Bearer xai-test-token");
		expect(reference).toMatchObject({
			provider: "xai",
			api: "openai-responses",
			fileId: "file_xai",
			endpoint: "https://api.x.ai/v1",
		});
	});
});
