import type { Candidate, Part } from "@google/genai";
import type { Api, AssistantMessage, CitationPart, Model, ProviderNativePart } from "../types.ts";

type GoogleApi = "google-generative-ai" | "google-vertex";

function hasNativePart(output: AssistantMessage, kind: string, payload: unknown): boolean {
	const encoded = JSON.stringify(payload);
	return (output.nativeParts ?? []).some((part) => part.kind === kind && JSON.stringify(part.payload) === encoded);
}

function appendNativePart<TApi extends GoogleApi>(
	output: AssistantMessage,
	model: Model<TApi>,
	kind: string,
	payload: unknown,
	stateId?: string,
): void {
	if (hasNativePart(output, kind, payload)) return;
	const part: ProviderNativePart = {
		type: "provider-native",
		provider: model.provider,
		api: model.api as Api,
		modelId: model.id,
		kind,
		payload: structuredClone(payload),
		portability: "provider-locked",
		...(stateId ? { stateId } : {}),
	};
	output.nativeParts = [...(output.nativeParts ?? []), part];
}

function groundingCitations(candidate: Candidate, provider: string): CitationPart[] {
	const citations: CitationPart[] = [];
	for (const [index, chunk] of (candidate.groundingMetadata?.groundingChunks ?? []).entries()) {
		const source = chunk.web ?? chunk.retrievedContext ?? chunk.maps ?? chunk.image;
		if (!source) continue;
		const url = "uri" in source ? source.uri : "sourceUri" in source ? source.sourceUri : undefined;
		const title = "title" in source ? source.title : undefined;
		const sourceId =
			"documentName" in source && typeof source.documentName === "string"
				? source.documentName
				: "placeId" in source && typeof source.placeId === "string"
					? source.placeId
					: `grounding-chunk-${index}`;
		citations.push({
			type: "citation",
			sourceId,
			...(title ? { title } : {}),
			...(url ? { url } : {}),
			provider,
			raw: structuredClone(chunk),
		});
	}
	for (const citation of candidate.citationMetadata?.citations ?? []) {
		citations.push({
			type: "citation",
			...(citation.title ? { title: citation.title } : {}),
			...(citation.uri ? { url: citation.uri } : {}),
			provider,
			raw: structuredClone(citation),
		});
	}
	return citations;
}

export function preserveGoogleCandidateState<TApi extends GoogleApi>(
	output: AssistantMessage,
	model: Model<TApi>,
	candidate: Candidate,
): void {
	if (candidate.groundingMetadata) {
		appendNativePart(output, model, "google.grounding_metadata", candidate.groundingMetadata);
	}
	if (candidate.urlContextMetadata) {
		appendNativePart(output, model, "google.url_context_metadata", candidate.urlContextMetadata);
	}
	if (candidate.citationMetadata) {
		appendNativePart(output, model, "google.citation_metadata", candidate.citationMetadata);
	}
	const citations = groundingCitations(candidate, model.provider);
	for (const citation of citations) {
		if (!(output.citations ?? []).some((existing) => JSON.stringify(existing.raw) === JSON.stringify(citation.raw))) {
			output.citations = [...(output.citations ?? []), citation];
		}
	}
}

export function preserveGooglePart<TApi extends GoogleApi>(
	output: AssistantMessage,
	model: Model<TApi>,
	part: Part,
): void {
	if (part.text !== undefined || part.functionCall !== undefined) return;
	const stateId = part.toolCall?.id ?? part.toolResponse?.id;
	appendNativePart(output, model, "google.part", part, stateId);
}

export function updateGoogleProviderState<TApi extends GoogleApi>(
	output: AssistantMessage,
	model: Model<TApi>,
	responseId: string | undefined,
	cachedContentId?: string,
): void {
	if (!responseId && !cachedContentId) return;
	output.providerState = {
		provider: model.provider,
		api: model.api as Api,
		modelId: model.id,
		...(responseId ? { responseId, continuationId: responseId } : {}),
		...(cachedContentId ? { cachedContentId } : {}),
	};
}

export function finalizeGoogleReasoningState<TApi extends GoogleApi>(
	output: AssistantMessage,
	model: Model<TApi>,
): void {
	const signatures = output.content.flatMap((block) => {
		if (block.type === "thinking" && block.thinkingSignature) return [block.thinkingSignature];
		if (block.type === "text" && block.textSignature) return [block.textSignature];
		if (block.type === "toolCall" && block.thoughtSignature) return [block.thoughtSignature];
		return [];
	});
	if (signatures.length === 0) return;
	output.reasoningState = signatures.map((signature) => ({
		provider: model.provider,
		api: model.api as Api,
		modelId: model.id,
		signature,
	}));
}
