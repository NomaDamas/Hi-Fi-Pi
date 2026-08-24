import { arch, platform, release } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "../src/api/openai-responses.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { resolveAttachmentUploadBackend } from "../src/attachment-lifecycle.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { resolveNativeInputCapability } from "../src/native-input-capabilities.ts";
import { getProviderOptionDefinitions } from "../src/provider-options.ts";
import { XAI_MODELS } from "../src/providers/xai.models.ts";
import { xaiProvider } from "../src/providers/xai.ts";
import type { AttachmentRecord, Context, Model } from "../src/types.ts";

const PI_USER_AGENT = `pi (${platform()} ${release()}; ${arch()})`;

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

const customCompletionsModel: Model<"openai-completions"> = {
	id: "grok-custom",
	name: "Grok Custom",
	api: "openai-completions",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

async function captureCompletionsUserAgent(headers?: Record<string, string>): Promise<string | null> {
	let userAgent: string | null = null;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		userAgent = new Request(input, init).headers.get("user-agent");
		const chunks = [
			{ id: "chatcmpl-ua", choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }] },
			{
				id: "chatcmpl-ua",
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];
		const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const result = await streamOpenAICompletions(
		customCompletionsModel,
		{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
		{ apiKey: "xai-test-token", headers },
	).result();

	expect(result.stopReason, result.errorMessage).toBe("stop");
	return userAgent;
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

	it("routes every built-in xAI model through Responses", () => {
		for (const model of Object.values(XAI_MODELS)) {
			expect(model.api, model.id).toBe("openai-responses");
		}
		expect(getSupportedThinkingLevels(XAI_MODELS["grok-4.5"])).toEqual(["low", "medium", "high"]);
		expect(getSupportedThinkingLevels(XAI_MODELS["grok-4.6"])).toEqual(["low", "medium", "high", "xhigh"]);
		expect(getSupportedThinkingLevels(XAI_MODELS["grok-4.3"])).toEqual(["off", "low", "medium", "high"]);
		expect(getSupportedThinkingLevels(XAI_MODELS["grok-build-0.1"])).toEqual(["low", "medium", "high"]);
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
		expect(captured.headers.get("user-agent")).toBe(PI_USER_AGENT);
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

	it("requests encrypted reasoning without an effort override", async () => {
		const captured = await captureRequest(
			XAI_MODELS["grok-4.5"],
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "xai-test-token" },
		);

		expect(captured.body).toMatchObject({
			model: "grok-4.5",
			store: false,
			include: ["reasoning.encrypted_content"],
		});
		expect(captured.body).not.toHaveProperty("reasoning");
	});

	it("uses /responses for Grok 4.6 with xhigh effort and encrypted reasoning", async () => {
		const captured = await captureRequest(
			XAI_MODELS["grok-4.6"],
			{
				systemPrompt: "You are a careful coding assistant.",
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{
				apiKey: "xai-test-token",
				reasoningEffort: "xhigh",
			},
		);

		expect(captured.url).toBe("https://api.x.ai/v1/responses");
		expect(captured.body).toMatchObject({
			model: "grok-4.6",
			store: false,
			stream: true,
			reasoning: { effort: "xhigh" },
			include: ["reasoning.encrypted_content"],
		});
	});

	it("uses /responses for Grok 4.3", async () => {
		const captured = await captureRequest(
			XAI_MODELS["grok-4.3"],
			{
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{
				apiKey: "xai-test-token",
				reasoningEffort: "low",
			},
		);

		expect(captured.url).toBe("https://api.x.ai/v1/responses");
		expect(captured.body).toMatchObject({
			model: "grok-4.3",
			store: false,
			include: ["reasoning.encrypted_content"],
			reasoning: { effort: "low" },
		});
	});

	it("uses pi's User-Agent by default for Responses requests", async () => {
		let userAgent: string | null = null;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			userAgent = new Request(input, init).headers.get("user-agent");
			return completedResponse();
		});

		const openaiModel: Model<"openai-responses"> = {
			...XAI_MODELS["grok-4.5"],
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		};
		const result = await streamOpenAIResponses(
			openaiModel,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "test-token" },
		).result();

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(userAgent).toBe(PI_USER_AGENT);
	});

	it("lets explicit headers override the default Responses User-Agent", async () => {
		const captured = await captureRequest(
			XAI_MODELS["grok-4.5"],
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "xai-test-token", headers: { "User-Agent": "custom-agent" } },
		);

		expect(captured.headers.get("user-agent")).toBe("custom-agent");
	});

	it("uses pi's User-Agent by default for Completions requests", async () => {
		expect(await captureCompletionsUserAgent()).toBe(PI_USER_AGENT);
	});

	it("lets explicit headers override the default Completions User-Agent", async () => {
		expect(await captureCompletionsUserAgent({ "User-Agent": "custom-agent" })).toBe("custom-agent");
	});
});
