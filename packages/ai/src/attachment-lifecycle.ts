import { getNativeAttachmentCapability } from "./api/attachment-lowering.ts";
import type { ProviderTraceRecorder } from "./provider-trace.ts";
import { sanitizeProviderTraceValue } from "./provider-trace.ts";
import type {
	Api,
	AttachmentRecord,
	AttachmentRegistry,
	AttachmentUploadOptions,
	FetchFunction,
	Model,
	ProviderFileReference,
	ProviderHeaders,
	StreamOptions,
} from "./types.ts";

export const ATTACHMENT_UPLOAD_BACKEND_VERSION = 1 as const;

export interface AttachmentUploadContext {
	model: Model<Api>;
	attachment: AttachmentRecord;
	bytes: Uint8Array;
	sha256: string;
	fetch: FetchFunction;
	apiKey?: string;
	headers?: ProviderHeaders;
	signal?: AbortSignal;
	expiresAfterSeconds?: number;
}

export interface AttachmentDeleteContext {
	model: Model<Api>;
	reference: ProviderFileReference;
	fetch: FetchFunction;
	apiKey?: string;
	headers?: ProviderHeaders;
	signal?: AbortSignal;
}

export interface AttachmentUploadBackend {
	apiVersion: typeof ATTACHMENT_UPLOAD_BACKEND_VERSION;
	id: string;
	matches(model: Model<Api>): boolean;
	upload(context: AttachmentUploadContext): Promise<ProviderFileReference>;
	delete?(context: AttachmentDeleteContext): Promise<void>;
}

const registeredUploadBackends = new Map<string, AttachmentUploadBackend>();
const inFlightByRegistry = new WeakMap<AttachmentRegistry, Map<string, Promise<AttachmentRecord>>>();

function canonicalEndpoint(baseUrl: string): string {
	const url = new URL(baseUrl);
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

function endpointHostname(model: Pick<Model<Api>, "baseUrl">): string | undefined {
	try {
		return new URL(model.baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function endpointWithVersion(baseUrl: string, path: string): string {
	const endpoint = canonicalEndpoint(baseUrl);
	if (/\/v\d+(?:beta)?$/i.test(new URL(endpoint).pathname)) return `${endpoint}${path}`;
	return `${endpoint}/v1${path}`;
}

function copyHeaders(headers: ProviderHeaders | undefined): Headers {
	const result = new Headers();
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (value !== null) result.set(key, value);
	}
	return result;
}

function requireApiKey(context: Pick<AttachmentUploadContext, "apiKey" | "headers">, provider: string): string {
	if (context.apiKey) return context.apiKey;
	const configured = Object.entries(context.headers ?? {}).some(
		([key, value]) => value !== null && ["authorization", "x-api-key", "x-goog-api-key"].includes(key.toLowerCase()),
	);
	if (configured) return "";
	throw new Error(`No API key available for ${provider} file upload`);
}

async function responseJson(response: Response, operation: string): Promise<Record<string, unknown>> {
	if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`);
	const value = (await response.json()) as unknown;
	if (!value || typeof value !== "object") throw new Error(`${operation} returned an invalid response`);
	return value as Record<string, unknown>;
}

function unixMillis(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function blobFor(context: AttachmentUploadContext): Blob {
	return new Blob([context.bytes], { type: context.attachment.mediaType });
}

const openAIUploadBackend: AttachmentUploadBackend = {
	apiVersion: ATTACHMENT_UPLOAD_BACKEND_VERSION,
	id: "openai-files-v1",
	matches: (model) =>
		model.provider === "openai" && model.api === "openai-responses" && endpointHostname(model) === "api.openai.com",
	upload: async (context) => {
		const apiKey = requireApiKey(context, "OpenAI");
		const headers = copyHeaders(context.headers);
		if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
		const form = new FormData();
		form.set("purpose", "user_data");
		form.set("file", blobFor(context), context.attachment.filename);
		if (context.expiresAfterSeconds !== undefined) {
			form.set("expires_after[anchor]", "created_at");
			form.set("expires_after[seconds]", String(context.expiresAfterSeconds));
		}
		const body = await responseJson(
			await context.fetch(endpointWithVersion(context.model.baseUrl, "/files"), {
				method: "POST",
				headers,
				body: form,
				signal: context.signal,
			}),
			"OpenAI file upload",
		);
		if (typeof body.id !== "string") throw new Error("OpenAI file upload response is missing id");
		return {
			provider: context.model.provider,
			api: context.model.api,
			fileId: body.id,
			endpoint: canonicalEndpoint(context.model.baseUrl),
			sourceSha256: context.sha256,
			uploadedAt: unixMillis(body.created_at) ?? Date.now(),
			...(unixMillis(body.expires_at) !== undefined ? { expiresAt: unixMillis(body.expires_at) } : {}),
			state: "ready",
			metadata: { backend: "openai-files-v1", purpose: "user_data" },
		};
	},
	delete: async (context) => {
		const apiKey = requireApiKey(context, "OpenAI");
		const headers = copyHeaders(context.headers);
		if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
		const response = await context.fetch(
			`${endpointWithVersion(context.model.baseUrl, "/files")}/${encodeURIComponent(context.reference.fileId)}`,
			{ method: "DELETE", headers, signal: context.signal },
		);
		if (!response.ok) throw new Error(`OpenAI file deletion failed with HTTP ${response.status}`);
	},
};

const anthropicUploadBackend: AttachmentUploadBackend = {
	apiVersion: ATTACHMENT_UPLOAD_BACKEND_VERSION,
	id: "anthropic-files-beta",
	matches: (model) =>
		model.provider === "anthropic" &&
		model.api === "anthropic-messages" &&
		endpointHostname(model) === "api.anthropic.com",
	upload: async (context) => {
		const apiKey = requireApiKey(context, "Anthropic");
		const headers = copyHeaders(context.headers);
		if (apiKey) headers.set("x-api-key", apiKey);
		headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01");
		headers.set("anthropic-beta", headers.get("anthropic-beta") ?? "files-api-2025-04-14");
		const form = new FormData();
		form.set("file", blobFor(context), context.attachment.filename);
		const body = await responseJson(
			await context.fetch(endpointWithVersion(context.model.baseUrl, "/files"), {
				method: "POST",
				headers,
				body: form,
				signal: context.signal,
			}),
			"Anthropic file upload",
		);
		if (typeof body.id !== "string") throw new Error("Anthropic file upload response is missing id");
		return {
			provider: context.model.provider,
			api: context.model.api,
			fileId: body.id,
			endpoint: canonicalEndpoint(context.model.baseUrl),
			sourceSha256: context.sha256,
			uploadedAt: unixMillis(body.created_at) ?? Date.now(),
			...(unixMillis(body.expires_at) !== undefined ? { expiresAt: unixMillis(body.expires_at) } : {}),
			state: "ready",
			metadata: { backend: "anthropic-files-beta" },
		};
	},
	delete: async (context) => {
		const apiKey = requireApiKey(context, "Anthropic");
		const headers = copyHeaders(context.headers);
		if (apiKey) headers.set("x-api-key", apiKey);
		headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01");
		headers.set("anthropic-beta", headers.get("anthropic-beta") ?? "files-api-2025-04-14");
		const response = await context.fetch(
			`${endpointWithVersion(context.model.baseUrl, "/files")}/${encodeURIComponent(context.reference.fileId)}`,
			{ method: "DELETE", headers, signal: context.signal },
		);
		if (!response.ok) throw new Error(`Anthropic file deletion failed with HTTP ${response.status}`);
	},
};

const geminiUploadBackend: AttachmentUploadBackend = {
	apiVersion: ATTACHMENT_UPLOAD_BACKEND_VERSION,
	id: "gemini-files-resumable",
	matches: (model) =>
		model.provider === "google" &&
		model.api === "google-generative-ai" &&
		endpointHostname(model) === "generativelanguage.googleapis.com",
	upload: async (context) => {
		const apiKey = requireApiKey(context, "Gemini");
		const headers = copyHeaders(context.headers);
		if (apiKey) headers.set("x-goog-api-key", apiKey);
		headers.set("content-type", "application/json");
		headers.set("x-goog-upload-protocol", "resumable");
		headers.set("x-goog-upload-command", "start");
		headers.set("x-goog-upload-header-content-length", String(context.bytes.byteLength));
		headers.set("x-goog-upload-header-content-type", context.attachment.mediaType);
		const endpoint = canonicalEndpoint(context.model.baseUrl);
		const origin = new URL(endpoint).origin;
		const startResponse = await context.fetch(`${origin}/upload/v1beta/files`, {
			method: "POST",
			headers,
			body: JSON.stringify({ file: { display_name: context.attachment.filename } }),
			signal: context.signal,
		});
		if (!startResponse.ok) throw new Error(`Gemini upload initialization failed with HTTP ${startResponse.status}`);
		const uploadUrl = startResponse.headers.get("x-goog-upload-url");
		if (!uploadUrl) throw new Error("Gemini upload initialization response is missing x-goog-upload-url");
		const uploadHeaders = copyHeaders(context.headers);
		if (apiKey) uploadHeaders.set("x-goog-api-key", apiKey);
		uploadHeaders.set("content-length", String(context.bytes.byteLength));
		uploadHeaders.set("content-type", context.attachment.mediaType);
		uploadHeaders.set("x-goog-upload-offset", "0");
		uploadHeaders.set("x-goog-upload-command", "upload, finalize");
		const body = await responseJson(
			await context.fetch(uploadUrl, {
				method: "POST",
				headers: uploadHeaders,
				body: context.bytes,
				signal: context.signal,
			}),
			"Gemini file upload",
		);
		const file = body.file as Record<string, unknown> | undefined;
		if (!file || typeof file.name !== "string") throw new Error("Gemini file upload response is missing file.name");
		return {
			provider: context.model.provider,
			api: context.model.api,
			fileId: file.name,
			...(typeof file.uri === "string" ? { uri: file.uri } : {}),
			endpoint,
			sourceSha256: context.sha256,
			uploadedAt: unixMillis(file.createTime) ?? Date.now(),
			...(unixMillis(file.expirationTime) !== undefined ? { expiresAt: unixMillis(file.expirationTime) } : {}),
			state: "ready",
			metadata: { backend: "gemini-files-resumable", processingState: file.state },
		};
	},
	delete: async (context) => {
		const apiKey = requireApiKey(context, "Gemini");
		const headers = copyHeaders(context.headers);
		if (apiKey) headers.set("x-goog-api-key", apiKey);
		const origin = new URL(canonicalEndpoint(context.model.baseUrl)).origin;
		const name = context.reference.fileId.startsWith("files/")
			? context.reference.fileId
			: `files/${context.reference.fileId}`;
		const response = await context.fetch(`${origin}/v1beta/${name}`, {
			method: "DELETE",
			headers,
			signal: context.signal,
		});
		if (!response.ok) throw new Error(`Gemini file deletion failed with HTTP ${response.status}`);
	},
};

const builtInUploadBackends = [openAIUploadBackend, anthropicUploadBackend, geminiUploadBackend];

export function registerAttachmentUploadBackend(backend: AttachmentUploadBackend): () => void {
	if (backend.apiVersion !== ATTACHMENT_UPLOAD_BACKEND_VERSION) {
		throw new Error(
			`Attachment upload backend ${backend.id} uses API version ${backend.apiVersion}; expected ${ATTACHMENT_UPLOAD_BACKEND_VERSION}`,
		);
	}
	if (registeredUploadBackends.has(backend.id))
		throw new Error(`Attachment upload backend already registered: ${backend.id}`);
	registeredUploadBackends.set(backend.id, backend);
	return () => registeredUploadBackends.delete(backend.id);
}

export function resolveAttachmentUploadBackend(model: Model<Api>): AttachmentUploadBackend | undefined {
	const matches = [...registeredUploadBackends.values(), ...builtInUploadBackends].filter((backend) =>
		backend.matches(model),
	);
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous attachment upload backends for ${model.provider}/${model.api}/${model.id}: ${matches.map((item) => item.id).join(", ")}`,
		);
	}
	return matches[0];
}

export function providerRemoteKey(model: Pick<Model<Api>, "provider" | "api" | "baseUrl">): string {
	return `${model.provider}:${model.api}:${canonicalEndpoint(model.baseUrl)}`;
}

export function findUsableProviderFile(
	attachment: AttachmentRecord,
	model: Pick<Model<Api>, "provider" | "api" | "baseUrl">,
	now = Date.now(),
): ProviderFileReference | undefined {
	const endpoint = canonicalEndpoint(model.baseUrl);
	return Object.values(attachment.remotes ?? {}).find(
		(remote) =>
			remote.provider === model.provider &&
			remote.api === model.api &&
			(remote.endpoint === undefined || remote.endpoint === endpoint) &&
			(remote.sourceSha256 === undefined ||
				attachment.sha256 === undefined ||
				remote.sourceSha256 === attachment.sha256) &&
			remote.state !== "deleted" &&
			(remote.expiresAt === undefined || remote.expiresAt > now),
	);
}

function decodeBase64(data: string): Uint8Array {
	const encoded = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
	const binary = atob(encoded.replace(/\s/g, ""));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function attachmentBytes(attachment: AttachmentRecord, registry: AttachmentRegistry): Uint8Array {
	if (attachment.source.type === "base64") {
		if (attachment.source.data === "[omitted from export]") throw new Error("inline bytes were redacted from export");
		return decodeBase64(attachment.source.data);
	}
	if (attachment.source.type === "path") {
		if (!registry.read) throw new Error("attachment registry cannot read local paths");
		return registry.read(attachment);
	}
	throw new Error(`source ${attachment.source.type} cannot be uploaded without an explicit source backend`);
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function progress(
	options: AttachmentUploadOptions,
	model: Model<Api>,
	attachment: AttachmentRecord,
	state: "starting" | "uploading" | "complete" | "failed" | "cancelled",
	loadedBytes: number,
	totalBytes: number,
	error?: string,
): Promise<void> {
	await options.onProgress?.({
		attachmentId: attachment.id,
		provider: model.provider,
		api: model.api,
		state,
		loadedBytes,
		totalBytes,
		...(error ? { error } : {}),
	});
}

function traceAttachment(attachment: AttachmentRecord) {
	return {
		id: attachment.id,
		filename: attachment.filename,
		mediaType: attachment.mediaType,
		...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
		...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
	};
}

export async function ensureAttachmentUploaded(
	model: Model<Api>,
	attachment: AttachmentRecord,
	registry: AttachmentRegistry,
	options: StreamOptions,
	trace?: ProviderTraceRecorder,
): Promise<AttachmentRecord> {
	const usable = findUsableProviderFile(attachment, model);
	if (usable) return attachment;
	const upload = options.attachmentUpload;
	if (!upload || upload.mode === "inline") return attachment;
	const remoteCapability = getNativeAttachmentCapability(model, attachment.mediaType, "provider-file");
	if (!remoteCapability.supported) {
		if (upload.allowInlineFallback) return attachment;
		throw new Error(remoteCapability.reason ?? `${attachment.mediaType} does not support provider file references`);
	}
	const backend = resolveAttachmentUploadBackend(model);
	if (!backend) {
		if (upload.allowInlineFallback) return attachment;
		throw new Error(`No opt-in attachment upload backend for ${model.provider}/${model.api}/${model.id}`);
	}
	const bytes = attachmentBytes(attachment, registry);
	const inlineCapability = getNativeAttachmentCapability(model, attachment.mediaType, "base64");
	if (
		upload.mode === "auto" &&
		attachment.metadata?.preferUpload !== true &&
		(inlineCapability.maximumInlineBytes === undefined || bytes.byteLength <= inlineCapability.maximumInlineBytes)
	) {
		return attachment;
	}
	const digest = attachment.sha256 ?? (await sha256(bytes));
	const key = `${attachment.id}:${providerRemoteKey(model)}:${digest}`;
	let inFlight = inFlightByRegistry.get(registry);
	if (!inFlight) {
		inFlight = new Map();
		inFlightByRegistry.set(registry, inFlight);
	}
	const existing = inFlight.get(key);
	if (existing) return existing;

	const operation = (async () => {
		options.signal?.throwIfAborted();
		await progress(upload, model, attachment, "starting", 0, bytes.byteLength);
		trace?.record({
			stage: "upload_start",
			attachment: traceAttachment(attachment),
			remote: { state: "uploading", provider: model.provider, api: model.api, fileId: "[pending]" },
			progress: { loadedBytes: 0, totalBytes: bytes.byteLength },
		});
		try {
			await progress(upload, model, attachment, "uploading", 0, bytes.byteLength);
			const reference = await backend.upload({
				model,
				attachment,
				bytes,
				sha256: digest,
				fetch: options.fetch ?? globalThis.fetch,
				apiKey: options.apiKey,
				headers: options.headers,
				signal: options.signal,
				expiresAfterSeconds: upload.expiresAfterSeconds,
			});
			const updated: AttachmentRecord = {
				...attachment,
				sha256: digest,
				sizeBytes: attachment.sizeBytes ?? bytes.byteLength,
				remotes: { ...attachment.remotes, [providerRemoteKey(model)]: reference },
			};
			await registry.update?.(updated);
			await progress(upload, model, attachment, "complete", bytes.byteLength, bytes.byteLength);
			trace?.record({
				stage: "upload_complete",
				attachment: traceAttachment(updated),
				remote: {
					state: "ready",
					provider: reference.provider,
					api: reference.api,
					fileId: reference.fileId,
					...(reference.uri ? { uri: String(sanitizeProviderTraceValue(reference.uri)) } : {}),
					...(reference.expiresAt !== undefined ? { expiresAt: reference.expiresAt } : {}),
				},
				progress: { loadedBytes: bytes.byteLength, totalBytes: bytes.byteLength },
			});
			return updated;
		} catch (error) {
			const cancelled = options.signal?.aborted === true;
			const message = cancelled ? "upload cancelled" : error instanceof Error ? error.message : String(error);
			await progress(upload, model, attachment, cancelled ? "cancelled" : "failed", 0, bytes.byteLength, message);
			trace?.record({
				stage: "upload_error",
				attachment: traceAttachment(attachment),
				remote: { state: "failed", provider: model.provider, api: model.api, fileId: "[none]" },
				error: message,
			});
			if (upload.allowInlineFallback && !cancelled) return attachment;
			throw error;
		}
	})();
	inFlight.set(key, operation);
	try {
		return await operation;
	} finally {
		inFlight.delete(key);
	}
}

export async function prepareContextAttachmentUploads(
	model: Model<Api>,
	context: {
		messages: Array<{ role: string; attachments?: Array<{ attachmentId: string }> }>;
		attachmentRegistry?: AttachmentRegistry;
	},
	options: StreamOptions | undefined,
	trace?: ProviderTraceRecorder,
): Promise<void> {
	if (!options?.attachmentUpload || options.attachmentUpload.mode === "inline") return;
	const ids = new Set(
		context.messages.flatMap((message) => message.attachments?.map((item) => item.attachmentId) ?? []),
	);
	if (ids.size === 0) return;
	if (!context.attachmentRegistry) throw new Error("Attachment registry is required for upload preparation");
	for (const id of ids) {
		const attachment = context.attachmentRegistry.resolve(id);
		if (!attachment) throw new Error(`Attachment not found: ${id}`);
		await ensureAttachmentUploaded(model, attachment, context.attachmentRegistry, options, trace);
	}
}

export async function deleteProviderAttachment(
	model: Model<Api>,
	attachment: AttachmentRecord,
	registry: AttachmentRegistry,
	options: Pick<StreamOptions, "apiKey" | "fetch" | "headers" | "signal">,
	trace?: ProviderTraceRecorder,
): Promise<AttachmentRecord> {
	const reference = findUsableProviderFile(attachment, model);
	if (!reference) throw new Error(`No active remote file for ${attachment.id} on ${model.provider}/${model.api}`);
	const backend = resolveAttachmentUploadBackend(model);
	if (!backend?.delete)
		throw new Error(`Attachment backend cannot delete remote files for ${model.provider}/${model.api}`);
	await backend.delete({
		model,
		reference,
		fetch: options.fetch ?? globalThis.fetch,
		apiKey: options.apiKey,
		headers: options.headers,
		signal: options.signal,
	});
	const key = Object.entries(attachment.remotes ?? {}).find(([, item]) => item === reference)?.[0];
	if (!key) throw new Error(`Remote reference index is missing for ${attachment.id}`);
	const updated: AttachmentRecord = {
		...attachment,
		remotes: {
			...attachment.remotes,
			[key]: { ...reference, state: "deleted", deletedAt: Date.now() },
		},
	};
	await registry.update?.(updated);
	trace?.record({
		stage: "remote_delete",
		attachment: traceAttachment(updated),
		remote: {
			state: "deleted",
			provider: reference.provider,
			api: reference.api,
			fileId: reference.fileId,
		},
	});
	return updated;
}
