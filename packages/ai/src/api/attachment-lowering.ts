import { resolveNativeInputCapability } from "../native-input-capabilities.ts";
import type {
	Api,
	AttachmentRecord,
	AttachmentRegistry,
	Model,
	NativeAttachmentTransportSource,
	NativeInputCapabilityProvenance,
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
	method?: string;
	sources?: NativeAttachmentTransportSource[];
	maximumInlineBytes?: number;
	maximumRequestBytes?: number;
	maximumCount?: number;
	capabilityId?: string;
	endpointProfile?: string;
	provenance?: NativeInputCapabilityProvenance;
	requiredHeaders?: Record<string, string>;
	options?: Record<string, unknown>;
	reason?: string;
}

type AttachmentCapabilityModel = Pick<
	Model<string>,
	"api" | "baseUrl" | "id" | "nativeAttachments" | "nativeInputs" | "provider"
>;

function transportSource(sourceType: AttachmentRecord["source"]["type"]): NativeAttachmentTransportSource {
	return sourceType === "path" || sourceType === "base64" ? "inline" : sourceType;
}

export function getNativeAttachmentCapability(
	model: AttachmentCapabilityModel,
	mediaType: string,
	sourceType?: AttachmentRecord["source"]["type"],
): NativeAttachmentCapability {
	const source = sourceType ? transportSource(sourceType) : undefined;
	const capability = resolveNativeInputCapability(model, mediaType, source);
	return {
		supported: capability.supported,
		...(capability.wireKind ? { method: capability.wireKind } : {}),
		...(capability.sources
			? {
					sources: capability.sources.filter(
						(candidate): candidate is NativeAttachmentTransportSource => candidate !== "cloud-uri",
					),
				}
			: {}),
		...(capability.limits?.maximumBytes !== undefined ? { maximumInlineBytes: capability.limits.maximumBytes } : {}),
		...(capability.limits?.maximumRequestBytes !== undefined
			? { maximumRequestBytes: capability.limits.maximumRequestBytes }
			: {}),
		...(capability.limits?.maximumCount !== undefined ? { maximumCount: capability.limits.maximumCount } : {}),
		...(capability.capabilityId ? { capabilityId: capability.capabilityId } : {}),
		...(capability.endpointProfile ? { endpointProfile: capability.endpointProfile } : {}),
		...(capability.provenance ? { provenance: capability.provenance } : {}),
		...(capability.requiredHeaders ? { requiredHeaders: capability.requiredHeaders } : {}),
		...(capability.options ? { options: capability.options } : {}),
		...(capability.reason ? { reason: capability.reason } : {}),
	};
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
