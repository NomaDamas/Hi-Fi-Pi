import { getNativeAttachmentCapability } from "@earendil-works/pi-ai";
import type { Api, AttachmentRecord, Model } from "@earendil-works/pi-ai/compat";

export interface AttachmentSourceRuntimeState {
	status: "available" | "missing" | "redacted";
	reason?: string;
}

export interface AttachmentTransportRuntimeState {
	status: "unresolved" | "ready" | "uploaded" | "unsupported";
	nativeMethod?: string;
	reason?: string;
}

export interface AttachmentRuntimeState {
	source: AttachmentSourceRuntimeState;
	transport: AttachmentTransportRuntimeState;
}

export interface ResolvedAttachment {
	record: AttachmentRecord;
	state: AttachmentRuntimeState;
}

export interface AttachmentRuntimeContext {
	model?: Model<Api>;
	source: AttachmentSourceRuntimeState;
	now: number;
}

export interface AttachmentSourceRuntimeContext {
	now: number;
	pathExists: (path: string) => boolean;
	redactInlineData?: boolean;
}

const LEGACY_RUNTIME_METADATA_KEYS = new Set([
	"sourceAvailable",
	"preparationStatus",
	"nativeMethod",
	"unsupportedReason",
]);

function normalizeEndpoint(endpoint: string): string {
	return endpoint.replace(/\/+$/, "");
}

export function resolveAttachmentSourceRuntime(
	record: AttachmentRecord,
	context: AttachmentSourceRuntimeContext,
): AttachmentSourceRuntimeState {
	switch (record.source.type) {
		case "path":
			return context.pathExists(record.source.path)
				? { status: "available" }
				: { status: "missing", reason: `Local source is unavailable: ${record.source.path}` };
		case "url":
		case "cloud-uri":
			return record.source.expiresAt !== undefined && record.source.expiresAt <= context.now
				? { status: "missing", reason: "Source URI has expired." }
				: { status: "available" };
		case "base64":
			return context.redactInlineData
				? { status: "redacted", reason: "Inline data is omitted." }
				: { status: "available" };
		case "provider-file":
			return { status: "available" };
	}
}

function hasMatchingRemote(attachment: AttachmentRecord, model: Model<Api>, now: number): boolean {
	const endpoint = normalizeEndpoint(model.baseUrl);
	return Object.values(attachment.remotes ?? {}).some(
		(remote) =>
			remote.provider === model.provider &&
			remote.api === model.api &&
			(remote.endpoint === undefined || normalizeEndpoint(remote.endpoint) === endpoint) &&
			(remote.sourceSha256 === undefined ||
				attachment.sha256 === undefined ||
				remote.sourceSha256 === attachment.sha256) &&
			remote.state !== "deleted" &&
			remote.state !== "failed" &&
			(remote.expiresAt === undefined || remote.expiresAt > now),
	);
}

/**
 * Resolve provider-neutral attachment identity into typed, ephemeral runtime state.
 *
 * The caller supplies source state and time, keeping filesystem access and clocks
 * outside this deterministic resolver. Persisted metadata is intentionally ignored.
 */
export function resolveAttachmentRuntime(
	record: AttachmentRecord,
	context: AttachmentRuntimeContext,
): ResolvedAttachment {
	if (!context.model) {
		return {
			record,
			state: {
				source: context.source,
				transport: { status: "unresolved" },
			},
		};
	}

	const matchingRemote = hasMatchingRemote(record, context.model, context.now);
	const capability = getNativeAttachmentCapability(
		context.model,
		record.mediaType,
		matchingRemote ? "provider-file" : record.source.type,
	);
	const nativeMethod = capability.method ? { nativeMethod: capability.method } : {};

	if (!capability.supported) {
		return {
			record,
			state: {
				source: context.source,
				transport: {
					status: "unsupported",
					...nativeMethod,
					...(capability.reason ? { reason: capability.reason } : {}),
				},
			},
		};
	}

	return {
		record,
		state: {
			source: context.source,
			transport: {
				status: matchingRemote || record.source.type === "provider-file" ? "uploaded" : "ready",
				...nativeMethod,
			},
		},
	};
}

/** Remove obsolete presentation-only metadata without touching opaque vendor metadata. */
export function stripLegacyAttachmentRuntimeMetadata(record: AttachmentRecord): AttachmentRecord {
	if (!record.metadata || !Object.keys(record.metadata).some((key) => LEGACY_RUNTIME_METADATA_KEYS.has(key))) {
		return record;
	}
	const metadata = Object.fromEntries(
		Object.entries(record.metadata).filter(([key]) => !LEGACY_RUNTIME_METADATA_KEYS.has(key)),
	);
	const { metadata: _legacyMetadata, ...withoutMetadata } = record;
	return Object.keys(metadata).length > 0 ? { ...withoutMetadata, metadata } : withoutMetadata;
}
