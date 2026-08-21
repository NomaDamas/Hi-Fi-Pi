import { existsSync, readFileSync } from "node:fs";
import type { AttachmentRecord, AttachmentReference, AttachmentRegistry } from "@earendil-works/pi-ai/compat";
import { resolveAttachmentSourceRuntime } from "./attachment-runtime.ts";

export interface AttachmentSessionStore {
	getAttachments(): AttachmentRecord[];
	appendAttachment(attachment: AttachmentRecord): unknown;
	updateAttachment(attachment: AttachmentRecord): unknown;
}

export interface AttachmentCoordinatorOptions {
	store: AttachmentSessionStore;
	bindRegistry: (registry: AttachmentRegistry | undefined) => void;
}

/**
 * Owns the session-scoped attachment registry and its persistence boundary.
 *
 * AgentSession remains responsible for deciding when prompt and event flows
 * carry attachment references. This coordinator owns record validation,
 * identity conflicts, branch restoration, source reads, and persistence.
 */
export class AttachmentCoordinator {
	private readonly store: AttachmentSessionStore;
	private readonly bindRegistry: (registry: AttachmentRegistry | undefined) => void;
	private readonly records = new Map<string, AttachmentRecord>();
	private readonly registry: AttachmentRegistry;

	constructor(options: AttachmentCoordinatorOptions) {
		this.store = options.store;
		this.bindRegistry = options.bindRegistry;
		this.registry = {
			resolve: (id) => this.records.get(id),
			read: (attachment) => {
				if (attachment.source.type !== "path") {
					throw new Error(`Attachment ${attachment.id} does not have a local path source.`);
				}
				return new Uint8Array(readFileSync(attachment.source.path));
			},
			list: () => Array.from(this.records.values()),
			update: (attachment) => {
				this.validate(attachment);
				if (!this.records.has(attachment.id)) {
					throw new Error(`Cannot update unknown attachment ID "${attachment.id}".`);
				}
				this.store.updateAttachment(attachment);
				this.records.set(attachment.id, attachment);
			},
		};
		this.syncFromActiveBranch();
	}

	register(attachments: readonly AttachmentRecord[] | undefined): AttachmentReference[] | undefined {
		if (attachments === undefined) return undefined;
		if (attachments.length === 0) return [];

		for (const attachment of attachments) {
			this.validate(attachment);
			const existing = this.records.get(attachment.id);
			if (existing && JSON.stringify(existing) !== JSON.stringify(attachment)) {
				throw new Error(`Attachment ID "${attachment.id}" is already registered with different metadata.`);
			}
			this.records.set(attachment.id, attachment);
		}
		this.bindRegistry(this.registry);
		return attachments.map((attachment) => ({
			type: "attachment",
			attachmentId: attachment.id,
		}));
	}

	syncFromActiveBranch(): void {
		this.records.clear();
		for (const attachment of this.store.getAttachments()) {
			this.records.set(attachment.id, attachment);
		}
		this.bindRegistry(this.records.size > 0 ? this.registry : undefined);
	}

	assertReferencesResolvable(attachments: readonly AttachmentReference[] | undefined): void {
		for (const attachment of attachments ?? []) {
			if (!this.records.has(attachment.attachmentId)) {
				throw new Error(`Unknown attachment ID: ${attachment.attachmentId}`);
			}
		}
	}

	persistReferences(attachments: readonly AttachmentReference[] | undefined): void {
		for (const reference of attachments ?? []) {
			const attachment = this.records.get(reference.attachmentId);
			if (!attachment) throw new Error(`Unknown attachment ID: ${reference.attachmentId}`);
			this.store.appendAttachment(attachment);
		}
	}

	discardUnpersistedReferences(attachments: readonly AttachmentReference[] | undefined): void {
		if (!attachments?.length) return;
		const persistedIds = new Set(this.store.getAttachments().map((attachment) => attachment.id));
		for (const reference of attachments) {
			if (!persistedIds.has(reference.attachmentId)) this.records.delete(reference.attachmentId);
		}
		this.bindRegistry(this.records.size > 0 ? this.registry : undefined);
	}

	listRecords(): readonly AttachmentRecord[] {
		return Array.from(this.records.values());
	}

	isSourceAvailable(attachment: AttachmentRecord): boolean {
		return (
			resolveAttachmentSourceRuntime(attachment, {
				now: Date.now(),
				pathExists: existsSync,
			}).status === "available"
		);
	}

	private validate(value: unknown): asserts value is AttachmentRecord {
		if (!value || typeof value !== "object") throw new Error("Invalid attachment: expected an object.");
		const record = value as Partial<AttachmentRecord>;
		if (typeof record.id !== "string" || record.id.length === 0) {
			throw new Error("Invalid attachment: id must be a non-empty string.");
		}
		if (typeof record.filename !== "string" || record.filename.length === 0) {
			throw new Error(`Invalid attachment "${record.id}": filename must be a non-empty string.`);
		}
		if (typeof record.mediaType !== "string" || record.mediaType.length === 0) {
			throw new Error(`Invalid attachment "${record.id}": mediaType must be a non-empty string.`);
		}
		if (!record.source || typeof record.source !== "object") {
			throw new Error(`Invalid attachment "${record.id}": source is required.`);
		}
		const source = record.source as {
			type?: unknown;
			path?: unknown;
			data?: unknown;
			url?: unknown;
			uri?: unknown;
			provider?: unknown;
			fileId?: unknown;
		};
		if (source.type === "path" && typeof source.path === "string" && source.path.length > 0) return;
		if (source.type === "base64" && typeof source.data === "string" && source.data.length > 0) return;
		if (source.type === "url" && typeof source.url === "string" && source.url.length > 0) return;
		if (source.type === "cloud-uri" && typeof source.uri === "string" && source.uri.length > 0) return;
		if (
			source.type === "provider-file" &&
			typeof source.provider === "string" &&
			source.provider.length > 0 &&
			typeof source.fileId === "string" &&
			source.fileId.length > 0
		) {
			return;
		}
		throw new Error(`Invalid attachment "${record.id}": unsupported or malformed source.`);
	}
}
