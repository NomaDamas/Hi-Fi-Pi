import type {
	Api,
	AttachmentRecord,
	AttachmentRegistry,
	Model,
	NativeAttachmentTransportSource,
	ProviderFileReference,
	ToolResultMessage,
	UserMessage,
} from "../types.ts";

type AttachmentMessage = UserMessage | ToolResultMessage;

export type ResolvedPdfAttachment = Omit<AttachmentRecord, "source"> & {
	source:
		| { type: "base64"; data: string }
		| { type: "url"; url: string }
		| { type: "provider-file"; fileId: string; uri?: string };
};

export class UnsupportedInputError extends Error {
	constructor(model: Pick<Model<string>, "provider" | "api" | "id">, mediaType: string, reason: string) {
		super(`${model.provider} ${model.api} model ${model.id} does not support ${mediaType} native input: ${reason}`);
		this.name = "UnsupportedInputError";
	}
}

export class AttachmentRegistryUnavailableError extends Error {
	constructor() {
		super("Attachment registry is required for messages with attachments");
		this.name = "AttachmentRegistryUnavailableError";
	}
}

export class AttachmentSourceUnavailableError extends Error {
	constructor(attachment: AttachmentRecord, reason: string) {
		super(`Attachment source is unavailable for ${attachment.id} (${attachment.filename}): ${reason}`);
		this.name = "AttachmentSourceUnavailableError";
	}
}

export interface NativeAttachmentCapability {
	supported: boolean;
	method?: "input_file" | "document" | "inlineData" | "fileData";
	sources?: NativeAttachmentTransportSource[];
	maximumInlineBytes?: number;
	maximumRequestBytes?: number;
	reason?: string;
}

const OPENAI_FILE_LIMIT_BYTES = 50 * 1024 * 1024;
const ANTHROPIC_REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;
const GEMINI_INLINE_LIMIT_BYTES = 50 * 1024 * 1024;

type AttachmentCapabilityModel = Pick<Model<string>, "api" | "baseUrl" | "id" | "nativeAttachments" | "provider">;

function getHostname(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function transportSource(sourceType: AttachmentRecord["source"]["type"]): NativeAttachmentTransportSource {
	return sourceType === "path" || sourceType === "base64" ? "inline" : sourceType;
}

function methodForApi(api: string, source?: NativeAttachmentTransportSource): NativeAttachmentCapability["method"] {
	if (api === "openai-responses") return "input_file";
	if (api === "anthropic-messages") return "document";
	if (api === "google-generative-ai" || api === "google-vertex") {
		return source === "inline" || source === undefined ? "inlineData" : "fileData";
	}
	return undefined;
}

function configuredPdfCapability(
	model: AttachmentCapabilityModel,
	source?: NativeAttachmentTransportSource,
): NativeAttachmentCapability | undefined {
	const configured = model.nativeAttachments?.pdf;
	if (!configured) return undefined;
	if (!configured.supported) return { supported: false, reason: "disabled by model configuration" };
	const sources = configured.sources ?? ["inline"];
	if (source && !sources.includes(source)) {
		return { supported: false, reason: `${source} sources are disabled by model configuration` };
	}
	const method = methodForApi(model.api, source);
	if (!method) return { supported: false, reason: `${model.api} has no PDF lowering implementation` };
	return {
		supported: true,
		method,
		sources,
		maximumInlineBytes: configured.maximumInlineBytes,
		maximumRequestBytes: configured.maximumRequestBytes,
	};
}

function officialPdfCapability(
	model: AttachmentCapabilityModel,
	source?: NativeAttachmentTransportSource,
): NativeAttachmentCapability | undefined {
	const hostname = getHostname(model.baseUrl);
	let sources: NativeAttachmentTransportSource[];
	let maximumInlineBytes: number;
	let maximumRequestBytes: number | undefined;

	if (model.provider === "openai" && model.api === "openai-responses" && hostname === "api.openai.com") {
		sources = ["inline", "url", "provider-file"];
		maximumInlineBytes = OPENAI_FILE_LIMIT_BYTES;
		maximumRequestBytes = OPENAI_FILE_LIMIT_BYTES;
	} else if (
		model.provider === "anthropic" &&
		model.api === "anthropic-messages" &&
		hostname === "api.anthropic.com"
	) {
		sources = ["inline", "url", "provider-file"];
		maximumInlineBytes = ANTHROPIC_REQUEST_LIMIT_BYTES;
		maximumRequestBytes = ANTHROPIC_REQUEST_LIMIT_BYTES;
	} else if (
		model.provider === "google" &&
		model.api === "google-generative-ai" &&
		hostname === "generativelanguage.googleapis.com"
	) {
		sources = ["inline", "url", "provider-file"];
		maximumInlineBytes = GEMINI_INLINE_LIMIT_BYTES;
	} else if (
		model.provider === "google-vertex" &&
		model.api === "google-vertex" &&
		hostname?.endsWith(".aiplatform.googleapis.com")
	) {
		sources = ["inline", "provider-file"];
		maximumInlineBytes = GEMINI_INLINE_LIMIT_BYTES;
	} else {
		return undefined;
	}

	if (source === "url" && model.provider === "google" && /^gemini-2\.0(?:-|$)/.test(model.id)) {
		return { supported: false, reason: `${model.id} does not support remote PDF URLs` };
	}
	if (source && !sources.includes(source)) {
		return { supported: false, reason: `${source} sources are not supported by the official endpoint` };
	}
	return {
		supported: true,
		method: methodForApi(model.api, source),
		sources,
		maximumInlineBytes,
		maximumRequestBytes,
	};
}

export function getNativeAttachmentCapability(
	model: AttachmentCapabilityModel,
	mediaType: string,
	sourceType?: AttachmentRecord["source"]["type"],
): NativeAttachmentCapability {
	if (mediaType !== "application/pdf") {
		return { supported: false, reason: "only application/pdf is enabled" };
	}
	const source = sourceType ? transportSource(sourceType) : undefined;
	return (
		configuredPdfCapability(model, source) ??
		officialPdfCapability(model, source) ?? {
			supported: false,
			reason: "custom endpoints require nativeAttachments.pdf.supported opt-in",
		}
	);
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function findRemote(
	attachment: AttachmentRecord,
	model: Pick<Model<string>, "provider" | "api">,
): ProviderFileReference | undefined {
	const now = Date.now();
	return Object.values(attachment.remotes ?? {}).find(
		(remote) =>
			remote.provider === model.provider &&
			remote.api === (model.api as Api) &&
			(remote.expiresAt === undefined || remote.expiresAt > now),
	);
}

function base64ByteLength(data: string): number {
	const encoded = (data.includes(",") ? data.slice(data.indexOf(",") + 1) : data).replace(/\s/g, "");
	if (encoded.length === 0) return 0;
	const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
	return Math.floor((encoded.length * 3) / 4) - padding;
}

function assertInlineSize(
	model: AttachmentCapabilityModel,
	attachment: AttachmentRecord,
	capability: NativeAttachmentCapability,
	sizeBytes: number,
): void {
	if (capability.maximumInlineBytes !== undefined && sizeBytes > capability.maximumInlineBytes) {
		throw new UnsupportedInputError(
			model,
			attachment.mediaType,
			`${attachment.filename} is ${sizeBytes} bytes; inline limit is ${capability.maximumInlineBytes} bytes`,
		);
	}
}

export function sanitizeProviderPayloadForTrace(payload: unknown): unknown {
	if (Array.isArray(payload)) return payload.map(sanitizeProviderPayloadForTrace);
	if (!payload || typeof payload !== "object") return payload;

	return Object.fromEntries(
		Object.entries(payload).map(([key, value]) => {
			if (
				typeof value === "string" &&
				(key === "file_data" || (key === "data" && value.length > 0)) &&
				(value.startsWith("data:") || /^[A-Za-z0-9+/]+={0,2}$/.test(value))
			) {
				return [key, `[redacted ${value.length} chars]`];
			}
			return [key, sanitizeProviderPayloadForTrace(value)];
		}),
	);
}

export function resolvePdfAttachments(
	message: AttachmentMessage,
	registry: AttachmentRegistry | undefined,
	model: AttachmentCapabilityModel,
): ResolvedPdfAttachment[] {
	if (!message.attachments || message.attachments.length === 0) return [];
	if (!registry) {
		throw new AttachmentRegistryUnavailableError();
	}

	const resolved = message.attachments.map<ResolvedPdfAttachment>(({ attachmentId }) => {
		const attachment = registry.resolve(attachmentId);
		if (!attachment) {
			throw new Error(`Attachment not found: ${attachmentId}`);
		}
		const capability = getNativeAttachmentCapability(model, attachment.mediaType);
		if (!capability.supported) {
			throw new UnsupportedInputError(model, attachment.mediaType, capability.reason ?? "unsupported input");
		}

		const remote = findRemote(attachment, model);
		const remoteCapability = getNativeAttachmentCapability(model, attachment.mediaType, "provider-file");
		if (remote && remoteCapability.supported) {
			return {
				...attachment,
				source: { type: "provider-file", fileId: remote.fileId, uri: remote.uri },
			};
		}

		switch (attachment.source.type) {
			case "base64": {
				if (attachment.source.data === "[omitted from export]") {
					throw new AttachmentSourceUnavailableError(attachment, "inline bytes were redacted from an export");
				}
				const sourceCapability = getNativeAttachmentCapability(model, attachment.mediaType, "base64");
				if (!sourceCapability.supported) {
					throw new UnsupportedInputError(
						model,
						attachment.mediaType,
						sourceCapability.reason ?? "base64 source is unsupported",
					);
				}
				assertInlineSize(model, attachment, sourceCapability, base64ByteLength(attachment.source.data));
				return { ...attachment, source: attachment.source };
			}
			case "url": {
				const sourceCapability = getNativeAttachmentCapability(model, attachment.mediaType, "url");
				if (!sourceCapability.supported) {
					throw new UnsupportedInputError(
						model,
						attachment.mediaType,
						sourceCapability.reason ?? "URL source is unsupported",
					);
				}
				return { ...attachment, source: attachment.source };
			}
			case "provider-file": {
				if (attachment.source.provider !== model.provider) {
					throw new UnsupportedInputError(
						model,
						attachment.mediaType,
						`provider file belongs to ${attachment.source.provider}`,
					);
				}
				const providerFileCapability = getNativeAttachmentCapability(model, attachment.mediaType, "provider-file");
				if (!providerFileCapability.supported) {
					throw new UnsupportedInputError(
						model,
						attachment.mediaType,
						providerFileCapability.reason ?? "provider file source is unsupported",
					);
				}
				return { ...attachment, source: attachment.source };
			}
			case "path": {
				const sourceCapability = getNativeAttachmentCapability(model, attachment.mediaType, "path");
				if (!sourceCapability.supported) {
					throw new UnsupportedInputError(
						model,
						attachment.mediaType,
						sourceCapability.reason ?? "local path source is unsupported",
					);
				}
				if (attachment.sizeBytes !== undefined) {
					assertInlineSize(model, attachment, sourceCapability, attachment.sizeBytes);
				}
				if (!registry.read) {
					throw new AttachmentSourceUnavailableError(
						attachment,
						"the attachment registry cannot read local paths",
					);
				}
				let bytes: Uint8Array;
				try {
					bytes = registry.read(attachment);
				} catch (error) {
					throw new AttachmentSourceUnavailableError(
						attachment,
						error instanceof Error ? error.message : String(error),
					);
				}
				assertInlineSize(model, attachment, sourceCapability, bytes.byteLength);
				return {
					...attachment,
					sizeBytes: attachment.sizeBytes ?? bytes.byteLength,
					source: { type: "base64", data: encodeBase64(bytes) },
				};
			}
		}
		throw new UnsupportedInputError(model, attachment.mediaType, "unknown attachment source");
	});

	const capability = getNativeAttachmentCapability(model, "application/pdf", "base64");
	if (capability.maximumRequestBytes !== undefined) {
		const requestBytes = resolved.reduce((total, attachment) => {
			if (attachment.source.type !== "base64") return total;
			return total + base64ByteLength(attachment.source.data);
		}, 0);
		if (requestBytes > capability.maximumRequestBytes) {
			throw new UnsupportedInputError(
				model,
				"application/pdf",
				`combined inline attachments are ${requestBytes} bytes; request limit is ${capability.maximumRequestBytes} bytes`,
			);
		}
	}
	return resolved;
}
