import { describe, expect, it } from "vitest";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { resolveNativeInputCapability } from "../src/native-input-capabilities.ts";
import { getProviderOptionDefinitions, resolveProviderOptions } from "../src/provider-options.ts";
import type { AttachmentRecord, Context, Model } from "../src/types.ts";

const endpoint = "https://hifipi.openai.azure.com/openai/v1";
const model: Model<"azure-openai-responses"> = {
	provider: "azure-openai-responses",
	api: "azure-openai-responses",
	id: "gpt-5.4",
	name: "gpt-5.4",
	baseUrl: endpoint,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
};

async function capturePayload(context: Context, options: Record<string, unknown> = {}): Promise<unknown> {
	let captured: unknown;
	await streamAzure(model, context, {
		apiKey: "test-key",
		azureBaseUrl: endpoint,
		azureDeploymentName: "deployment-gpt-5.4",
		providerOptions: resolveProviderOptions(model, options),
		onPayload: (payload) => {
			captured = payload;
			throw new Error("captured");
		},
	}).result();
	return captured;
}

describe("Azure OpenAI official native contract", () => {
	it("recognizes only official Azure endpoints and exposes Azure-scoped controls", () => {
		expect(resolveNativeInputCapability(model, "application/pdf", "inline")).toMatchObject({
			supported: true,
			endpointProfile: "azure-openai-official",
			wireKind: "input_file",
		});
		expect(getProviderOptionDefinitions(model).map((definition) => definition.key)).toContain(
			"azure.responses.previous_response_id",
		);

		const proxy = { ...model, baseUrl: "https://proxy.example.com/v1" };
		expect(resolveNativeInputCapability(proxy, "application/pdf", "inline")).toMatchObject({ supported: false });
		expect(getProviderOptionDefinitions(proxy)).toEqual([]);
	});

	it("lowers inline PDFs and keeps deployment identity distinct from the model catalog ID", async () => {
		const attachment: AttachmentRecord = {
			id: "att_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "base64", data: "JVBERi0xLjQ=" },
		};
		const payload = (await capturePayload(
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
				"azure.responses.store": true,
				"azure.responses.background": true,
				"azure.responses.text_format": { type: "json_schema", name: "answer", schema: { type: "object" } },
			},
		)) as {
			model: string;
			input: Array<{ content?: Array<Record<string, unknown>> }>;
			store: boolean;
			background: boolean;
		};
		expect(payload.model).toBe("deployment-gpt-5.4");
		expect(payload.store).toBe(true);
		expect(payload.background).toBe(true);
		expect(payload.input[0]?.content?.[0]).toMatchObject({
			type: "input_file",
			filename: "paper.pdf",
			file_data: "data:application/pdf;base64,JVBERi0xLjQ=",
		});
	});

	it("rejects remote file IDs owned by another provider before network execution", async () => {
		const attachment: AttachmentRecord = {
			id: "att_remote",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "provider-file", provider: "openai", fileId: "file_openai" },
		};
		const result = await streamAzure(
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
			{ apiKey: "test-key", azureBaseUrl: endpoint },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/belongs to openai/);
	});

	it("validates Azure API versions before constructing a request", async () => {
		const result = await streamAzure(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "test-key", azureBaseUrl: endpoint, azureApiVersion: "latest-unversioned" },
		).result();
		expect(result.errorMessage).toContain("Invalid Azure OpenAI API version");
	});
});
