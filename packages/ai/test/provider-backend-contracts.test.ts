import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAttachmentUploadBackend } from "../src/attachment-lifecycle.ts";
import { createModels, createProvider } from "../src/models.ts";
import {
	AmbiguousProviderBackendError,
	inspectProviderBackendSelection,
	listProviderBackends,
	PROVIDER_BACKEND_API_VERSION,
	ProviderBackendVersionError,
	registerProviderBackend,
} from "../src/provider-backend.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AttachmentRecord, Context, Model, ProviderStreams } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"third-party-api"> = {
	id: "document-model",
	name: "Document Model",
	api: "third-party-api",
	provider: "third-party",
	baseUrl: "https://vendor.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_000,
	maxTokens: 2_000,
};

function streamText(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = { ...fauxAssistantMessage(text), api: model.api, provider: model.provider, model: model.id };
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

function provider(legacy: (context: Context) => AssistantMessageEventStream) {
	const streams: ProviderStreams = {
		stream: (_model, context) => legacy(context),
		streamSimple: (_model, context) => legacy(context),
	};
	return createProvider({
		id: model.provider,
		auth: { apiKey: { name: "Ambient", resolve: async () => ({ auth: {} }) } },
		models: [model],
		api: streams,
	});
}

describe("provider backend SDK", () => {
	const unregister: Array<() => void> = [];

	afterEach(() => {
		for (const dispose of unregister.splice(0)) dispose();
	});

	it("uses the existing provider as an inspectable compatibility backend", async () => {
		const legacy = vi.fn((_context: Context) => streamText("legacy"));
		const models = createModels();
		models.setProvider(provider(legacy));
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

		const result = await models.complete(model, context);

		expect(result.content).toEqual([{ type: "text", text: "legacy" }]);
		expect(legacy).toHaveBeenCalledWith(context);
		expect(inspectProviderBackendSelection(model)).toMatchObject({
			kind: "legacy",
			id: "legacy:third-party/third-party-api",
		});
	});

	it("lets a third-party backend lower an attachment and stream a response", async () => {
		const attachment: AttachmentRecord = {
			id: "att_1",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "base64", data: "JVBERi0xLjQ=" },
		};
		const prepareInput = vi.fn((input) => {
			const reference =
				input.conversation.messages[0]?.role === "user"
					? input.conversation.messages[0].attachments?.[0]
					: undefined;
			const record = reference ? input.conversation.attachmentRegistry?.resolve(reference.attachmentId) : undefined;
			return {
				request: {
					input: [
						{
							type: "vendor_document",
							mime_type: record?.mediaType,
							data: record?.source.type === "base64" ? record.source.data : undefined,
						},
					],
				},
			};
		});
		unregister.push(
			registerProviderBackend({
				apiVersion: PROVIDER_BACKEND_API_VERSION,
				id: "third-party-documents",
				match: {
					provider: model.provider,
					api: model.api,
					baseUrl: model.baseUrl,
				},
				resolveCapabilities: () => ({ inputs: { document: { mediaTypes: ["application/pdf"] } } }),
				prepareInput,
				stream: (input) => streamText(JSON.stringify(input.request)),
			}),
		);
		const legacy = vi.fn((_context: Context) => streamText("legacy"));
		const models = createModels();
		models.setProvider(provider(legacy));
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "analyze",
					attachments: [{ type: "attachment", attachmentId: attachment.id }],
					timestamp: 1,
				},
			],
			attachmentRegistry: { resolve: (id) => (id === attachment.id ? attachment : undefined) },
		};

		const result = await models.complete(model, context);

		expect(legacy).not.toHaveBeenCalled();
		expect(prepareInput).toHaveBeenCalledOnce();
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({
					input: [{ type: "vendor_document", mime_type: "application/pdf", data: "JVBERi0xLjQ=" }],
				}),
			},
		]);
		expect(inspectProviderBackendSelection(model)).toMatchObject({
			kind: "registered",
			id: "third-party-documents",
		});
		expect(
			await inspectProviderBackendSelection(model).backend?.resolveCapabilities?.(
				inspectProviderBackendSelection(model).context,
			),
		).toEqual({
			inputs: { document: { mediaTypes: ["application/pdf"] } },
		});
	});

	it("bridges backend-owned upload and delete lifecycle methods", async () => {
		const uploadAttachment = vi.fn(async ({ model: requestModel, attachment, sha256 }) => ({
			provider: requestModel.provider,
			api: requestModel.api,
			fileId: `remote_${attachment.id}`,
			sourceSha256: sha256,
			uploadedAt: 1,
		}));
		const deleteRemoteFile = vi.fn(async () => {});
		unregister.push(
			registerProviderBackend({
				apiVersion: 1,
				id: "third-party-files",
				match: { provider: model.provider, api: model.api, baseUrl: model.baseUrl },
				stream: () => streamText("ok"),
				uploadAttachment,
				deleteRemoteFile,
			}),
		);

		const lifecycle = resolveAttachmentUploadBackend(model);
		expect(lifecycle?.id).toBe("provider-backend:third-party-files");
		const attachment: AttachmentRecord = {
			id: "att_upload",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "base64", data: "JVBERg==" },
		};
		const reference = await lifecycle?.upload({
			model,
			attachment,
			bytes: new Uint8Array([1, 2, 3]),
			sha256: "abc",
			fetch,
		});
		expect(reference).toMatchObject({ fileId: "remote_att_upload", sourceSha256: "abc" });
		await lifecycle?.delete?.({ model, reference: reference!, fetch });
		expect(uploadAttachment).toHaveBeenCalledOnce();
		expect(deleteRemoteFile).toHaveBeenCalledOnce();
	});

	it("rejects incompatible API versions clearly", () => {
		expect(() =>
			registerProviderBackend({
				apiVersion: 2,
				id: "future-backend",
				match: { baseUrl: model.baseUrl },
				stream: () => streamText("unused"),
			}),
		).toThrow(ProviderBackendVersionError);
	});

	it("detects equally specific ambiguous matches", () => {
		for (const id of ["ambiguous-a", "ambiguous-b"]) {
			unregister.push(
				registerProviderBackend({
					apiVersion: 1,
					id,
					match: { provider: model.provider, baseUrl: model.baseUrl },
					stream: () => streamText(id),
				}),
			);
		}
		expect(() => inspectProviderBackendSelection(model)).toThrow(AmbiguousProviderBackendError);
	});

	it("requires explicit custom endpoint opt-in", () => {
		unregister.push(
			registerProviderBackend({
				apiVersion: 1,
				id: "missing-endpoint-opt-in",
				match: { provider: model.provider, api: model.api },
				stream: () => streamText("should not run"),
			}),
		);

		const selection = inspectProviderBackendSelection(model);
		expect(selection.kind).toBe("legacy");
		expect(selection.candidates).toContainEqual(
			expect.objectContaining({
				id: "missing-endpoint-opt-in",
				matched: false,
				reason: expect.stringContaining("opt into endpoints"),
			}),
		);
	});

	it("does not retain registrations after disposal", () => {
		const dispose = registerProviderBackend({
			apiVersion: 1,
			id: "temporary-backend",
			match: { baseUrl: model.baseUrl },
			stream: () => streamText("temporary"),
		});
		expect(listProviderBackends().map((backend) => backend.id)).toContain("temporary-backend");
		dispose();
		expect(listProviderBackends().map((backend) => backend.id)).not.toContain("temporary-backend");
	});
});
