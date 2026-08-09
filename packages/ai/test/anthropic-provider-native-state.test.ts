import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import { resolveProviderOptions } from "../src/provider-options.ts";
import type { AssistantMessage, Context } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: unknown }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({ asResponse: async () => response }),
		},
	} as unknown as Anthropic;
}

function priorAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "searched" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		nativeParts: [
			{
				type: "provider-native",
				provider: "anthropic",
				api: "anthropic-messages",
				kind: "anthropic.content_block",
				payload: {
					type: "web_search_tool_result",
					tool_use_id: "srv_1",
					content: [
						{
							type: "web_search_result",
							url: "https://example.com",
							title: "Example",
							encrypted_content: "opaque",
						},
					],
				},
				portability: "provider-locked",
			},
		],
		providerState: {
			provider: "anthropic",
			api: "anthropic-messages",
			responseId: "msg_prior",
			metadata: { containerId: "container_1" },
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
	};
}

describe("Anthropic provider-native state", () => {
	it("replays native server blocks and container state while applying server tools and context management", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-6");
		const context: Context = {
			messages: [priorAssistant(), { role: "user", content: "continue", timestamp: 2 }],
		};
		let captured: unknown;
		await streamAnthropic(model, context, {
			apiKey: "test-key",
			cacheRetention: "none",
			providerOptions: resolveProviderOptions(model, {
				"anthropic.server_tools": [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
				"anthropic.context_management": {
					edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 100_000 } }],
				},
			}),
			onPayload: (payload) => {
				captured = payload;
				throw new Error("captured");
			},
		}).result();
		const payload = captured as {
			container?: string;
			context_management?: unknown;
			messages: Array<{ content: unknown }>;
			tools?: unknown[];
		};
		expect(payload.container).toBe("container_1");
		expect(payload.context_management).toEqual(
			expect.objectContaining({
				edits: expect.arrayContaining([expect.objectContaining({ type: "clear_tool_uses_20250919" })]),
			}),
		);
		expect(payload.tools).toContainEqual(
			expect.objectContaining({ type: "web_search_20250305", name: "web_search" }),
		);
		expect(payload.messages[0]?.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "web_search_tool_result", tool_use_id: "srv_1" })]),
		);
	});

	it("preserves server tool blocks, citations, thinking signatures, usage and container state", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-6");
		const response = createSseResponse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						container: { id: "container_1", expires_at: "2026-08-08T00:00:00Z" },
						usage: {
							input_tokens: 5,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				},
			},
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"query":"Pi"}' },
				},
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srv_1",
						content: [
							{
								type: "web_search_result",
								url: "https://example.com",
								title: "Example",
								encrypted_content: "opaque",
							},
						],
					},
				},
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 2,
					content_block: { type: "thinking", thinking: "", signature: "" },
				},
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "reason" } },
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 2,
					delta: { type: "signature_delta", signature: "signature_1" },
				},
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 3,
					delta: {
						type: "citations_delta",
						citation: {
							type: "web_search_result_location",
							cited_text: "Example",
							encrypted_index: "opaque-index",
							title: "Example",
							url: "https://example.com",
						},
					},
				},
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 3 } },
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: 5,
						output_tokens: 4,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
						server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
					},
				},
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const result = await streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "search", timestamp: 1 }] },
			{ client: createFakeAnthropicClient(response), cacheRetention: "none" },
		).result();

		expect(result.nativeParts).toEqual([
			expect.objectContaining({
				kind: "anthropic.content_block",
				stateId: "srv_1",
				payload: expect.objectContaining({ type: "server_tool_use", input: { query: "Pi" } }),
			}),
			expect.objectContaining({
				kind: "anthropic.content_block",
				stateId: "srv_1",
				payload: expect.objectContaining({ type: "web_search_tool_result" }),
			}),
		]);
		expect(result.citations).toEqual([
			expect.objectContaining({ title: "Example", url: "https://example.com", quotedText: "Example" }),
		]);
		expect(result.reasoningState).toEqual([expect.objectContaining({ signature: "signature_1" })]);
		expect(result.providerState).toMatchObject({
			responseId: "msg_1",
			metadata: {
				containerId: "container_1",
				serverToolUse: { web_search_requests: 1, web_fetch_requests: 0 },
			},
		});
	});
});
