import { afterEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamOpenAI } from "../src/api/openai-responses.ts";
import { registerProviderBackend } from "../src/provider-backend.ts";
import {
	getProviderOptionDefinitions,
	ProviderOptionValidationError,
	resolveProviderOptions,
	withResolvedProviderOptions,
} from "../src/provider-options.ts";
import type { Api, AttachmentRecord, Context, Model, ProviderTraceEvent } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function model<TApi extends Api>(provider: string, api: TApi, id: string, baseUrl: string): Model<TApi> {
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

const openAIModel = model("openai", "openai-responses", "gpt-5.6", "https://api.openai.com/v1");
const anthropicModel = model("anthropic", "anthropic-messages", "claude-sonnet-4-6", "https://api.anthropic.com");
const googleModel = model(
	"google",
	"google-generative-ai",
	"gemini-3-pro",
	"https://generativelanguage.googleapis.com",
);
const textContext: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

async function capturePayload(
	stream: (options: { onPayload: (payload: unknown) => never }) => AssistantMessageEventStream,
): Promise<unknown> {
	let payload: unknown;
	await stream({
		onPayload: (value) => {
			payload = value;
			throw new Error("payload captured");
		},
	}).result();
	return payload;
}

describe("provider-native options", () => {
	const unregister: Array<() => void> = [];

	afterEach(() => {
		for (const dispose of unregister.splice(0)) dispose();
	});

	it("exposes only definitions compatible with the selected official backend", () => {
		expect(getProviderOptionDefinitions(openAIModel).map((definition) => definition.key)).toEqual([
			"openai.responses.store",
			"openai.responses.service_tier",
			"openai.responses.previous_response_id",
			"openai.responses.continue",
			"openai.responses.text_format",
			"openai.responses.built_in_tools",
			"openai.responses.background",
		]);
		expect(getProviderOptionDefinitions(anthropicModel).map((definition) => definition.key)).toEqual([
			"anthropic.document.citations",
			"anthropic.cache_retention",
			"anthropic.server_tools",
			"anthropic.context_management",
		]);
		expect(getProviderOptionDefinitions(googleModel).map((definition) => definition.key)).toEqual([
			"google.video.fps",
			"google.thinking_budget",
			"google.cached_content",
			"google.google_search",
			"google.url_context",
			"google.code_execution",
		]);
	});

	it("validates defaults, enums, ranges, unknown keys and secret-bearing values", () => {
		expect(resolveProviderOptions(openAIModel, { "openai.responses.service_tier": "flex" })).toEqual({
			"openai.responses.store": false,
			"openai.responses.service_tier": "flex",
			"openai.responses.continue": false,
			"openai.responses.background": false,
		});
		expect(() => resolveProviderOptions(googleModel, { "google.video.fps": 60 })).toThrow(/at most 24/);
		expect(() => resolveProviderOptions(openAIModel, { "openai.responses.service_tier": "invalid" })).toThrow(
			/must be one of/,
		);
		expect(() => resolveProviderOptions(openAIModel, { "openai.unknown": true })).toThrow(
			ProviderOptionValidationError,
		);
		expect(() => resolveProviderOptions(openAIModel, { "openai.api_key": "secret" })).toThrow(/secret-bearing/);
	});

	it("validates provider-native structured controls before request construction", () => {
		expect(() =>
			resolveProviderOptions(openAIModel, {
				"openai.responses.built_in_tools": [{ type: "mcp", server_url: "https://example.com" }],
			}),
		).toThrow(/unsupported built-in tool type/);
		expect(() =>
			resolveProviderOptions(openAIModel, {
				"openai.responses.text_format": { type: "json_schema", schema: {} },
			}),
		).toThrow(/non-empty name/);
		expect(() =>
			resolveProviderOptions(anthropicModel, {
				"anthropic.server_tools": [{ type: "client_tool", name: "not_server_side" }],
			}),
		).toThrow(/unsupported Anthropic server tool type/);
	});

	it("applies OpenAI continuation, structured output, background mode and built-in tools", async () => {
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "prior" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.6",
					providerState: {
						provider: "openai",
						api: "openai-responses",
						responseId: "resp_previous",
						continuationId: "resp_previous",
					},
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
				},
				{ role: "user", content: "continue", timestamp: 2 },
			],
		};
		const payload = (await capturePayload(({ onPayload }) =>
			streamOpenAI(openAIModel, context, {
				apiKey: "test-key",
				providerOptions: resolveProviderOptions(openAIModel, {
					"openai.responses.continue": true,
					"openai.responses.background": true,
					"openai.responses.text_format": {
						type: "json_schema",
						name: "answer",
						schema: { type: "object", properties: { answer: { type: "string" } } },
						strict: true,
					},
					"openai.responses.built_in_tools": [
						{ type: "web_search" },
						{ type: "code_interpreter", container: { type: "auto" } },
					],
				}),
				onPayload,
			}),
		)) as Record<string, unknown>;
		expect(payload).toMatchObject({
			previous_response_id: "resp_previous",
			background: true,
			text: { format: { type: "json_schema", name: "answer", strict: true } },
		});
		expect(payload.tools).toEqual([
			{ type: "web_search" },
			{ type: "code_interpreter", container: { type: "auto" } },
		]);
		expect(payload.include).toEqual(
			expect.arrayContaining(["web_search_call.action.sources", "code_interpreter_call.outputs"]),
		);
	});

	it("lets one backend register multiple vendor namespaces without modifying common option unions", () => {
		const customModel = model("multi-vendor", "multi-api", "model-1", "https://multi.example/v1");
		unregister.push(
			registerProviderBackend({
				apiVersion: 1,
				id: "multi-vendor-options",
				match: { provider: customModel.provider, baseUrl: customModel.baseUrl },
				options: [
					{ key: "openai.mode", type: "enum", description: "OpenAI mode", allowedValues: ["fast"] },
					{ key: "anthropic.citations", type: "boolean", description: "Citations" },
					{ key: "google.media", type: "structured", description: "Media configuration" },
				],
				stream: () => new AssistantMessageEventStream(),
			}),
		);

		expect(
			resolveProviderOptions(customModel, {
				"openai.mode": "fast",
				"anthropic.citations": true,
				"google.media": { fps: 2 },
			}),
		).toEqual({
			"openai.mode": "fast",
			"anthropic.citations": true,
			"google.media": { fps: 2 },
		});
	});

	it("preserves the legacy options object when no provider option was supplied", () => {
		const options = { temperature: 0.2 };
		expect(withResolvedProviderOptions(openAIModel, options)).toBe(options);
	});

	it("applies OpenAI store and service tier and traces effective options", async () => {
		const trace: ProviderTraceEvent[] = [];
		const payload = (await capturePayload(({ onPayload }) =>
			streamOpenAI(openAIModel, textContext, {
				apiKey: "test-key",
				providerOptions: resolveProviderOptions(openAIModel, {
					"openai.responses.store": true,
					"openai.responses.service_tier": "flex",
				}),
				onTrace: (event) => {
					trace.push(event);
				},
				onPayload,
			}),
		)) as { store: boolean; service_tier: string };
		expect(payload).toMatchObject({ store: true, service_tier: "flex" });
		expect(trace).toContainEqual(
			expect.objectContaining({
				stage: "provider_options",
				options: expect.objectContaining({
					"openai.responses.store": true,
					"openai.responses.service_tier": "flex",
				}),
			}),
		);
	});

	it("applies Anthropic document citations without changing attachment-free message shape", async () => {
		const attachment: AttachmentRecord = {
			id: "att_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "base64", data: "JVBERg==" },
		};
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "analyze",
					attachments: [{ type: "attachment", attachmentId: attachment.id }],
					timestamp: 1,
				},
			],
			attachmentRegistry: { resolve: () => attachment },
		};
		const payload = (await capturePayload(({ onPayload }) =>
			streamAnthropic(anthropicModel, context, {
				apiKey: "test-key",
				cacheRetention: "none",
				providerOptions: resolveProviderOptions(anthropicModel, {
					"anthropic.document.citations": true,
				}),
				onPayload,
			}),
		)) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
		expect(payload.messages[0]?.content[0]).toMatchObject({
			type: "document",
			citations: { enabled: true },
		});
	});

	it("applies Gemini media, thinking, cached content and built-in tool controls", async () => {
		const attachment: AttachmentRecord = {
			id: "att_video",
			filename: "demo.mp4",
			mediaType: "video/mp4",
			source: { type: "base64", data: "AAAA" },
		};
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "analyze",
					attachments: [{ type: "attachment", attachmentId: attachment.id }],
					timestamp: 1,
				},
			],
			attachmentRegistry: { resolve: () => attachment },
		};
		const payload = (await capturePayload(({ onPayload }) =>
			streamGoogle(googleModel, context, {
				apiKey: "test-key",
				thinking: { enabled: true },
				providerOptions: resolveProviderOptions(googleModel, {
					"google.video.fps": 2,
					"google.thinking_budget": 8192,
					"google.cached_content": "cachedContents/cache_1",
					"google.google_search": true,
					"google.url_context": true,
					"google.code_execution": true,
				}),
				onPayload,
			}),
		)) as {
			contents: Array<{ parts: Array<{ videoMetadata?: { fps: number } }> }>;
			config: {
				thinkingConfig: { thinkingBudget: number };
				cachedContent: string;
				tools: Array<Record<string, unknown>>;
			};
		};
		expect(payload.contents[0]?.parts[0]?.videoMetadata).toEqual({ fps: 2 });
		expect(payload.config.thinkingConfig.thinkingBudget).toBe(8192);
		expect(payload.config.cachedContent).toBe("cachedContents/cache_1");
		expect(payload.config.tools).toEqual([{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }]);
	});
});
