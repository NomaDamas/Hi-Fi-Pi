import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"openai-responses"> = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5.6",
	name: "gpt-5.6",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
};

function output(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "pending",
		timestamp: 1,
	};
}

async function* events(values: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const value of values) yield value as ResponseStreamEvent;
}

describe("OpenAI Responses provider-native state", () => {
	it("preserves hosted tool output, citations, response state and encrypted reasoning", async () => {
		const message = output();
		const stream = new AssistantMessageEventStream();
		await processResponsesStream(
			events([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "web_search_call",
						id: "ws_1",
						status: "completed",
						action: { type: "search", query: "Hi-Fi Pi" },
					},
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: {
						type: "reasoning",
						id: "rs_1",
						status: "completed",
						summary: [{ type: "summary_text", text: "checked sources" }],
						encrypted_content: "encrypted-reasoning",
					},
				},
				{
					type: "response.output_item.done",
					output_index: 2,
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [
							{
								type: "output_text",
								text: "Source",
								annotations: [
									{
										type: "url_citation",
										url: "https://example.com/source",
										title: "Source",
										start_index: 0,
										end_index: 6,
									},
								],
							},
						],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_1",
						status: "completed",
						background: false,
						output: [],
						usage: {
							input_tokens: 10,
							output_tokens: 5,
							total_tokens: 15,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens_details: { reasoning_tokens: 1 },
						},
					},
				},
			]),
			message,
			stream,
			model,
		);

		expect(message.nativeParts).toEqual([
			expect.objectContaining({
				kind: "openai.responses.output_item",
				stateId: "ws_1",
				payload: expect.objectContaining({ type: "web_search_call" }),
			}),
		]);
		expect(message.citations).toEqual([
			expect.objectContaining({
				title: "Source",
				url: "https://example.com/source",
				quotedText: "Source",
			}),
		]);
		expect(message.reasoningState).toEqual([
			expect.objectContaining({
				encrypted: "encrypted-reasoning",
				metadata: { itemId: "rs_1", status: "completed" },
			}),
		]);
		expect(message.providerState).toMatchObject({
			provider: "openai",
			api: "openai-responses",
			responseId: "resp_1",
			continuationId: "resp_1",
		});
	});

	it("replays same-backend hosted tool items without turning them into client tool calls", () => {
		const prior: AssistantMessage = {
			...output(),
			stopReason: "stop",
			nativeParts: [
				{
					type: "provider-native",
					provider: "openai",
					api: "openai-responses",
					kind: "openai.responses.output_item",
					payload: {
						type: "file_search_call",
						id: "fs_1",
						status: "completed",
						queries: ["paper"],
						results: null,
					},
					portability: "provider-locked",
				},
			],
		};
		const context: Context = { messages: [prior, { role: "user", content: "continue", timestamp: 2 }] };
		const input = convertResponsesMessages(model, context, new Set(["openai"]));
		expect(input).toContainEqual(expect.objectContaining({ type: "file_search_call", id: "fs_1" }));
	});
});
