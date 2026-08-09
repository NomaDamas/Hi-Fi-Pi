import { describe, expect, it } from "vitest";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { resolveNativeInputCapability } from "../src/native-input-capabilities.ts";
import { resolveProviderOptions } from "../src/provider-options.ts";
import type { AttachmentRecord, Context, Model, ProviderTraceEvent } from "../src/types.ts";

const model: Model<"google-vertex"> = {
	provider: "google-vertex",
	api: "google-vertex",
	id: "gemini-3-pro",
	name: "gemini-3-pro",
	baseUrl: "https://us-central1-aiplatform.googleapis.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
};

async function capturePayload(context: Context, trace: ProviderTraceEvent[] = []): Promise<unknown> {
	let captured: unknown;
	await streamVertex(model, context, {
		apiKey: "test-key",
		project: "hifipi-project",
		location: "us-central1",
		providerOptions: resolveProviderOptions(model, {
			"google.cached_content": "projects/hifipi-project/locations/us-central1/cachedContents/cache_1",
			"google.google_search": true,
			"google.code_execution": true,
		}),
		onTrace: (event) => {
			trace.push(event);
		},
		onPayload: (payload) => {
			captured = payload;
			throw new Error("captured");
		},
	}).result();
	return captured;
}

describe("Vertex AI native contract", () => {
	it("reports Vertex provenance separately from the Gemini Developer API", () => {
		expect(resolveNativeInputCapability(model, "application/pdf", "inline")).toMatchObject({
			supported: true,
			endpointProfile: "vertex-official",
			wireKind: "inlineData",
		});
		expect(resolveNativeInputCapability(model, "application/pdf", "cloud-uri")).toMatchObject({
			supported: true,
			endpointProfile: "vertex-official",
			wireKind: "fileData",
		});
	});

	it("lowers inline and GCS files, applies Vertex controls and traces the exact method", async () => {
		const inline: AttachmentRecord = {
			id: "att_inline",
			filename: "inline.pdf",
			mediaType: "application/pdf",
			source: { type: "base64", data: "JVBERg==" },
		};
		const gcs: AttachmentRecord = {
			id: "att_gcs",
			filename: "gcs.pdf",
			mediaType: "application/pdf",
			source: {
				type: "cloud-uri",
				uri: "gs://hifipi-bucket/paper.pdf",
				provider: "google-vertex",
				api: "google-vertex",
			},
		};
		const byId = new Map([
			[inline.id, inline],
			[gcs.id, gcs],
		]);
		const trace: ProviderTraceEvent[] = [];
		const payload = (await capturePayload(
			{
				messages: [
					{
						role: "user",
						content: "compare",
						attachments: [inline, gcs].map((attachment) => ({
							type: "attachment" as const,
							attachmentId: attachment.id,
						})),
						timestamp: 1,
					},
				],
				attachmentRegistry: { resolve: (id) => byId.get(id) },
			},
			trace,
		)) as {
			contents: Array<{ parts: Array<Record<string, unknown>> }>;
			config: { cachedContent: string; tools: Array<Record<string, unknown>> };
		};
		expect(payload.contents[0]?.parts).toEqual(
			expect.arrayContaining([
				{ inlineData: { mimeType: "application/pdf", data: "JVBERg==" } },
				{ fileData: { mimeType: "application/pdf", fileUri: "gs://hifipi-bucket/paper.pdf" } },
			]),
		);
		expect(payload.config.cachedContent).toContain("/cachedContents/cache_1");
		expect(payload.config.tools).toEqual([{ googleSearch: {} }, { codeExecution: {} }]);
		expect(trace).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: "provider_lowering", wire: { kind: "inlineData", source: "inline" } }),
				expect.objectContaining({ stage: "provider_lowering", wire: { kind: "fileData", source: "cloud-uri" } }),
			]),
		);
	});

	it("rejects non-GCS cloud URIs before Vertex network execution", async () => {
		const attachment: AttachmentRecord = {
			id: "att_http",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "cloud-uri", uri: "https://example.com/paper.pdf", provider: "google-vertex" },
		};
		const result = await streamVertex(
			model,
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
			{ apiKey: "test-key", project: "hifipi-project", location: "us-central1" },
		).result();
		expect(result.errorMessage).toContain("must use gs://");
	});

	it("validates ADC project and location identifiers", async () => {
		const result = await streamVertex(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "gcp-vertex-credentials",
				project: "invalid project",
				location: "us central1",
			},
		).result();
		expect(result.errorMessage).toContain("Invalid Vertex AI project identifier");
	});
});
