import { type Candidate, type Part, UrlRetrievalStatus } from "@google/genai";
import { describe, expect, it } from "vitest";
import {
	finalizeGoogleReasoningState,
	preserveGoogleCandidateState,
	preserveGooglePart,
	updateGoogleProviderState,
} from "../src/api/google-native-state.ts";
import { convertMessages } from "../src/api/google-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

const model: Model<"google-generative-ai"> = {
	provider: "google",
	api: "google-generative-ai",
	id: "gemini-3-pro",
	name: "gemini-3-pro",
	baseUrl: "https://generativelanguage.googleapis.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
};

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "reason", thinkingSignature: "c2lnbmF0dXJl" },
			{ type: "text", text: "answer", textSignature: "dGV4dHNpZw==" },
		],
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
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("Google provider-native state", () => {
	it("preserves grounding, citations, code execution, cached state and thought signatures", () => {
		const output = assistant();
		const candidate: Candidate = {
			groundingMetadata: {
				webSearchQueries: ["Hi-Fi Pi"],
				groundingChunks: [{ web: { uri: "https://example.com/pi", title: "Pi" } }],
			},
			citationMetadata: {
				citations: [{ uri: "https://example.com/direct", title: "Direct", startIndex: 0, endIndex: 6 }],
			},
			urlContextMetadata: {
				urlMetadata: [
					{
						retrievedUrl: "https://example.com/pi",
						urlRetrievalStatus: UrlRetrievalStatus.URL_RETRIEVAL_STATUS_SUCCESS,
					},
				],
			},
		};
		preserveGoogleCandidateState(output, model, candidate);
		preserveGooglePart(output, model, {
			executableCode: { language: "PYTHON", code: "print(1)" },
			thoughtSignature: "Y29kZXNpZw==",
		} as Part);
		preserveGooglePart(output, model, {
			codeExecutionResult: { outcome: "OUTCOME_OK", output: "1" },
		} as Part);
		updateGoogleProviderState(output, model, "response_1", "cachedContents/cache_1");
		finalizeGoogleReasoningState(output, model);

		expect(output.nativeParts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "google.grounding_metadata" }),
				expect.objectContaining({ kind: "google.citation_metadata" }),
				expect.objectContaining({ kind: "google.url_context_metadata" }),
				expect.objectContaining({
					kind: "google.part",
					payload: expect.objectContaining({ executableCode: expect.any(Object) }),
				}),
				expect.objectContaining({
					kind: "google.part",
					payload: expect.objectContaining({ codeExecutionResult: expect.any(Object) }),
				}),
			]),
		);
		expect(output.citations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ title: "Pi", url: "https://example.com/pi" }),
				expect.objectContaining({ title: "Direct", url: "https://example.com/direct" }),
			]),
		);
		expect(output.providerState).toMatchObject({
			responseId: "response_1",
			continuationId: "response_1",
			cachedContentId: "cachedContents/cache_1",
		});
		expect(output.reasoningState?.map((state) => state.signature)).toEqual(["c2lnbmF0dXJl", "dGV4dHNpZw=="]);
	});

	it("replays native Gemini parts only to the matching provider, transport and model", () => {
		const prior = assistant();
		prior.nativeParts = [
			{
				type: "provider-native",
				provider: "google",
				api: "google-generative-ai",
				modelId: "gemini-3-pro",
				kind: "google.part",
				payload: { executableCode: { language: "PYTHON", code: "print(1)" } },
				portability: "provider-locked",
			},
		];
		const context: Context = { messages: [prior, { role: "user", content: "continue", timestamp: 2 }] };
		const contents = convertMessages(model, context);
		expect(contents[0]?.parts).toContainEqual(
			expect.objectContaining({ executableCode: { language: "PYTHON", code: "print(1)" } }),
		);

		const otherModel = { ...model, id: "gemini-3-flash" };
		const otherContents = convertMessages(otherModel, context);
		expect(otherContents[0]?.parts).not.toContainEqual(
			expect.objectContaining({ executableCode: expect.any(Object) }),
		);
	});
});
