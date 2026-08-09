import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAI } from "../src/api/openai-responses.ts";
import {
	ATTACHMENT_UPLOAD_BACKEND_VERSION,
	deleteProviderAttachment,
	ensureAttachmentUploaded,
	findUsableProviderFile,
	providerRemoteKey,
	registerAttachmentUploadBackend,
} from "../src/attachment-lifecycle.ts";
import type { AttachmentRecord, AttachmentRegistry, Model, ProviderFileReference } from "../src/types.ts";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nnative lifecycle\n");
const PDF_BASE64 = btoa(String.fromCharCode(...PDF_BYTES));

function model<TApi extends "openai-responses" | "anthropic-messages" | "google-generative-ai">(
	api: TApi,
	provider: string,
): Model<TApi> {
	const baseUrl = {
		"openai-responses": "https://api.openai.com/v1",
		"anthropic-messages": "https://api.anthropic.com",
		"google-generative-ai": "https://generativelanguage.googleapis.com",
	}[api];
	return {
		id: `${provider}-files-test`,
		name: `${provider} files test`,
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function attachment(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
	return {
		id: "att_lifecycle",
		filename: "paper.pdf",
		mediaType: "application/pdf",
		sizeBytes: PDF_BYTES.byteLength,
		source: { type: "base64", data: PDF_BASE64 },
		...overrides,
	};
}

function registry(initial = attachment()) {
	let current = initial;
	const updates: AttachmentRecord[] = [];
	const value: AttachmentRegistry = {
		resolve: (id) => (id === current.id ? current : undefined),
		read: () => PDF_BYTES,
		update: (next) => {
			current = next;
			updates.push(next);
		},
	};
	return { value, current: () => current, updates };
}

function uploadOptions(fetch: typeof globalThis.fetch, signal?: AbortSignal) {
	return {
		apiKey: "test-key",
		fetch,
		signal,
		attachmentUpload: { mode: "upload" as const },
	};
}

describe("provider file lifecycle", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("uploads an OpenAI file once and reuses the endpoint-scoped reference", async () => {
		const currentModel = model("openai-responses", "openai");
		const store = registry();
		let form: FormData | undefined;
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			form = init?.body as FormData;
			return new Response(
				JSON.stringify({ id: "file_openai_1", created_at: 1_700_000_000, expires_at: 4_000_000_000 }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		await ensureAttachmentUploaded(currentModel, store.current(), store.value, uploadOptions(fetch));
		await ensureAttachmentUploaded(currentModel, store.current(), store.value, uploadOptions(fetch));

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(form?.get("purpose")).toBe("user_data");
		expect((form?.get("file") as File).name).toBe("paper.pdf");
		expect(store.updates).toHaveLength(1);
		expect(findUsableProviderFile(store.current(), currentModel)).toMatchObject({
			fileId: "file_openai_1",
			endpoint: "https://api.openai.com/v1",
			state: "ready",
		});
	});

	it("prepares the remote before OpenAI payload lowering", async () => {
		const currentModel = model("openai-responses", "openai");
		const store = registry();
		let payload: unknown;
		const traceStages: string[] = [];
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "file_prepared", created_at: 4_000_000_000 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as typeof globalThis.fetch;
		const result = streamOpenAI(
			currentModel,
			{
				messages: [
					{
						role: "user",
						content: "Analyze",
						attachments: [{ type: "attachment", attachmentId: store.current().id }],
						timestamp: 1,
					},
				],
				attachmentRegistry: store.value,
			},
			{
				...uploadOptions(fetch),
				onPayload: (value) => {
					payload = value;
					throw new Error("payload captured");
				},
				onTrace: (event) => {
					traceStages.push(event.stage);
				},
			},
		);
		await result.result();

		expect(fetch).toHaveBeenCalledOnce();
		expect(JSON.stringify(payload)).toContain('"file_id":"file_prepared"');
		expect(JSON.stringify(payload)).not.toContain(PDF_BASE64);
		expect(traceStages).toEqual(expect.arrayContaining(["upload_start", "upload_complete", "remote_reuse"]));
	});

	it("refreshes an expired reference without corrupting the prior record", async () => {
		const currentModel = model("openai-responses", "openai");
		const expired: ProviderFileReference = {
			provider: "openai",
			api: "openai-responses",
			fileId: "file_expired",
			endpoint: currentModel.baseUrl,
			uploadedAt: 1,
			expiresAt: Date.now() - 1,
			state: "ready",
		};
		const store = registry(attachment({ remotes: { old: expired } }));
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "file_fresh", created_at: 1_800_000_000 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as typeof globalThis.fetch;

		await ensureAttachmentUploaded(currentModel, store.current(), store.value, uploadOptions(fetch));

		expect(fetch).toHaveBeenCalledOnce();
		expect(store.current().remotes?.old).toEqual(expired);
		expect(store.current().remotes?.[providerRemoteKey(currentModel)]?.fileId).toBe("file_fresh");
	});

	it("isolates reusable IDs by provider endpoint", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...model("openai-responses", "openai"),
			baseUrl: "https://tenant.example.test/v1",
			nativeInputs: {
				profile: "test-proxy",
				capabilities: [
					{
						id: "proxy-pdf",
						supported: true,
						mediaTypes: ["application/pdf"],
						sources: ["provider-file"],
						wireKinds: { "provider-file": "input_file" },
						provenance: "configured",
					},
				],
			},
		};
		const official = model("openai-responses", "openai");
		const store = registry(
			attachment({
				remotes: {
					official: {
						provider: "openai",
						api: "openai-responses",
						fileId: "file_other_tenant",
						endpoint: official.baseUrl,
						uploadedAt: Date.now(),
						state: "ready",
					},
				},
			}),
		);
		const unregister = registerAttachmentUploadBackend({
			apiVersion: ATTACHMENT_UPLOAD_BACKEND_VERSION,
			id: "test-proxy-upload",
			matches: (candidate) => candidate.baseUrl === proxyModel.baseUrl,
			upload: async (context) => ({
				provider: context.model.provider,
				api: context.model.api,
				fileId: "file_proxy",
				endpoint: context.model.baseUrl,
				uploadedAt: Date.now(),
				state: "ready",
			}),
		});
		try {
			await ensureAttachmentUploaded(proxyModel, store.current(), store.value, uploadOptions(globalThis.fetch));
		} finally {
			unregister();
		}

		expect(findUsableProviderFile(store.current(), official)?.fileId).toBe("file_other_tenant");
		expect(findUsableProviderFile(store.current(), proxyModel)?.fileId).toBe("file_proxy");
	});

	it("uses Anthropic multipart and Gemini resumable official transports", async () => {
		const anthropicStore = registry();
		const anthropicFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "file_anthropic", created_at: "2026-08-08T00:00:00Z" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as typeof globalThis.fetch;
		await ensureAttachmentUploaded(
			model("anthropic-messages", "anthropic"),
			anthropicStore.current(),
			anthropicStore.value,
			uploadOptions(anthropicFetch),
		);

		const geminiStore = registry();
		const geminiFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 200,
					headers: { "x-goog-upload-url": "https://upload.example.test/session" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						file: {
							name: "files/gemini-1",
							uri: "https://generativelanguage.googleapis.com/v1beta/files/gemini-1",
							createTime: "2026-08-08T00:00:00Z",
							expirationTime: "2026-08-10T00:00:00Z",
							state: "ACTIVE",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			) as typeof globalThis.fetch;
		await ensureAttachmentUploaded(
			model("google-generative-ai", "google"),
			geminiStore.current(),
			geminiStore.value,
			uploadOptions(geminiFetch),
		);

		expect(
			anthropicStore.current().remotes?.[providerRemoteKey(model("anthropic-messages", "anthropic"))],
		).toMatchObject({ fileId: "file_anthropic" });
		expect(geminiFetch).toHaveBeenCalledTimes(2);
		expect(geminiStore.current().remotes?.[providerRemoteKey(model("google-generative-ai", "google"))]).toMatchObject(
			{ fileId: "files/gemini-1", state: "ready" },
		);
	});

	it("keeps registry state deterministic on failure and cancellation", async () => {
		const currentModel = model("openai-responses", "openai");
		const failedStore = registry();
		const failedFetch = vi.fn(async () => new Response("no", { status: 500 })) as typeof globalThis.fetch;
		await expect(
			ensureAttachmentUploaded(currentModel, failedStore.current(), failedStore.value, uploadOptions(failedFetch)),
		).rejects.toThrow("HTTP 500");
		expect(failedStore.updates).toEqual([]);

		const controller = new AbortController();
		controller.abort();
		const cancelledStore = registry();
		const unusedFetch = vi.fn() as unknown as typeof globalThis.fetch;
		await expect(
			ensureAttachmentUploaded(
				currentModel,
				cancelledStore.current(),
				cancelledStore.value,
				uploadOptions(unusedFetch, controller.signal),
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(unusedFetch).not.toHaveBeenCalled();
		expect(cancelledStore.updates).toEqual([]);
	});

	it("only falls back inline when policy explicitly allows it", async () => {
		const proxyModel = {
			...model("openai-responses", "proxy"),
			baseUrl: "https://proxy.example.test/v1",
			nativeInputs: {
				profile: "inline-only",
				capabilities: [
					{
						id: "inline-pdf",
						supported: true,
						mediaTypes: ["application/pdf"],
						sources: ["inline" as const],
						wireKinds: { inline: "input_file" },
						provenance: "configured" as const,
					},
				],
			},
		} satisfies Model<"openai-responses">;
		const store = registry();

		await expect(
			ensureAttachmentUploaded(proxyModel, store.current(), store.value, uploadOptions(globalThis.fetch)),
		).rejects.toThrow("provider-file source");
		await expect(
			ensureAttachmentUploaded(proxyModel, store.current(), store.value, {
				...uploadOptions(globalThis.fetch),
				attachmentUpload: { mode: "upload", allowInlineFallback: true },
			}),
		).resolves.toEqual(store.current());
	});

	it("deletes only on explicit request and retains an audited tombstone", async () => {
		const currentModel = model("openai-responses", "openai");
		const active: ProviderFileReference = {
			provider: "openai",
			api: "openai-responses",
			fileId: "file_delete_me",
			endpoint: currentModel.baseUrl,
			uploadedAt: Date.now(),
			state: "ready",
		};
		const store = registry(attachment({ remotes: { [providerRemoteKey(currentModel)]: active } }));
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: active.fileId, deleted: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as typeof globalThis.fetch;

		await deleteProviderAttachment(currentModel, store.current(), store.value, {
			apiKey: "test-key",
			fetch,
		});

		expect(fetch).toHaveBeenCalledOnce();
		expect(store.current().remotes?.[providerRemoteKey(currentModel)]).toMatchObject({
			fileId: active.fileId,
			state: "deleted",
			deletedAt: expect.any(Number),
		});
		expect(findUsableProviderFile(store.current(), currentModel)).toBeUndefined();
	});
});
