import type {
	Api,
	AttachmentRecord,
	AttachmentRegistry,
	Model,
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
	model: Pick<Model<string>, "provider" | "api" | "id">,
): ResolvedPdfAttachment[] {
	if (!message.attachments || message.attachments.length === 0) return [];
	if (!registry) {
		throw new AttachmentRegistryUnavailableError();
	}

	return message.attachments.map(({ attachmentId }) => {
		const attachment = registry.resolve(attachmentId);
		if (!attachment) {
			throw new Error(`Attachment not found: ${attachmentId}`);
		}
		if (attachment.mediaType !== "application/pdf") {
			throw new UnsupportedInputError(model, attachment.mediaType, "only application/pdf is enabled");
		}

		const remote = findRemote(attachment, model);
		if (remote) {
			return {
				...attachment,
				source: { type: "provider-file", fileId: remote.fileId, uri: remote.uri },
			};
		}

		switch (attachment.source.type) {
			case "base64":
			case "url":
				return { ...attachment, source: attachment.source };
			case "provider-file":
				if (attachment.source.provider !== model.provider) {
					throw new UnsupportedInputError(
						model,
						attachment.mediaType,
						`provider file belongs to ${attachment.source.provider}`,
					);
				}
				return { ...attachment, source: attachment.source };
			case "path": {
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
				return { ...attachment, source: { type: "base64", data: encodeBase64(bytes) } };
			}
		}
		throw new UnsupportedInputError(model, attachment.mediaType, "unknown attachment source");
	});
}
