import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
	AttachmentRecord,
	AttachmentRegistry,
	AttachmentSource,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";
import { SessionManager } from "../core/session-manager.ts";

export interface ProductIdentity {
	tenantId: string;
	userId: string;
	agentId: string;
	threadId: string;
}

export interface ProductStoragePaths {
	root: string;
	tenant: string;
	user: string;
	agent: string;
	thread: string;
	sessions: string;
	attachments: string;
	packages: string;
}

export interface ProductStorageAuditEvent {
	type: "product_storage_audit";
	action: "attachment_store" | "attachment_update" | "attachment_delete" | "session_open" | "cleanup";
	identity: ProductIdentity;
	timestamp: number;
	resourceId?: string;
	details?: Record<string, string | number | boolean>;
}

export interface ProductStorageOptions {
	root: string;
	onAudit?: (event: ProductStorageAuditEvent) => void | Promise<void>;
}

export class ProductStorageBoundaryError extends Error {
	constructor(message: string) {
		super(`Product storage boundary rejected access: ${message}`);
		this.name = "ProductStorageBoundaryError";
	}
}

interface StoredAttachmentMetadata {
	version: 1;
	identity: ProductIdentity;
	createdAt: number;
	record: AttachmentRecord;
}

function assertIdentitySegment(value: string, name: keyof ProductIdentity): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
		throw new ProductStorageBoundaryError(`${name} is invalid`);
	}
	return value;
}

export function validateProductIdentity(identity: ProductIdentity): ProductIdentity {
	return {
		tenantId: assertIdentitySegment(identity.tenantId, "tenantId"),
		userId: assertIdentitySegment(identity.userId, "userId"),
		agentId: assertIdentitySegment(identity.agentId, "agentId"),
		threadId: assertIdentitySegment(identity.threadId, "threadId"),
	};
}

function isWithin(root: string, candidate: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedCandidate = resolve(candidate);
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function assertWithin(root: string, candidate: string, label: string): string {
	const resolvedCandidate = resolve(candidate);
	if (!isWithin(root, resolvedCandidate)) throw new ProductStorageBoundaryError(`${label} escapes its storage scope`);
	return resolvedCandidate;
}

function atomicJsonWrite(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	renameSync(temporary, path);
}

function cloneAttachment(record: AttachmentRecord): AttachmentRecord {
	return structuredClone(record);
}

export class FilesystemProductStorage {
	readonly root: string;
	private readonly onAudit?: ProductStorageOptions["onAudit"];

	constructor(options: ProductStorageOptions) {
		if (!options.root || options.root.trim().length === 0) {
			throw new ProductStorageBoundaryError("an explicit non-empty root is required");
		}
		this.root = resolve(options.root);
		this.onAudit = options.onAudit;
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
	}

	pathsFor(identityInput: ProductIdentity): ProductStoragePaths {
		const identity = validateProductIdentity(identityInput);
		const tenant = assertWithin(this.root, join(this.root, "tenants", identity.tenantId), "tenant path");
		const user = assertWithin(tenant, join(tenant, "users", identity.userId), "user path");
		const agent = assertWithin(user, join(user, "agents", identity.agentId), "agent path");
		const thread = assertWithin(agent, join(agent, "threads", identity.threadId), "thread path");
		return {
			root: this.root,
			tenant,
			user,
			agent,
			thread,
			sessions: join(thread, "sessions"),
			attachments: join(thread, "attachments"),
			packages: join(agent, "packages"),
		};
	}

	createSessionManager(
		identityInput: ProductIdentity,
		cwd: string,
		options: { resumeRecent?: boolean } = {},
	): SessionManager {
		const identity = validateProductIdentity(identityInput);
		const paths = this.pathsFor(identity);
		mkdirSync(paths.sessions, { recursive: true, mode: 0o700 });
		void this.audit({ type: "product_storage_audit", action: "session_open", identity, timestamp: Date.now() });
		return options.resumeRecent
			? SessionManager.continueRecent(cwd, paths.sessions)
			: SessionManager.create(cwd, paths.sessions);
	}

	openSessionManager(identityInput: ProductIdentity, sessionFile: string, cwdOverride?: string): SessionManager {
		const identity = validateProductIdentity(identityInput);
		const paths = this.pathsFor(identity);
		if (basename(sessionFile) !== sessionFile) {
			throw new ProductStorageBoundaryError("session file must be a scoped basename");
		}
		const path = assertWithin(paths.sessions, join(paths.sessions, sessionFile), "session file");
		if (!existsSync(path) || !statSync(path).isFile()) {
			throw new ProductStorageBoundaryError(`session does not exist: ${sessionFile}`);
		}
		void this.audit({
			type: "product_storage_audit",
			action: "session_open",
			identity,
			timestamp: Date.now(),
			resourceId: sessionFile,
		});
		return SessionManager.open(path, paths.sessions, cwdOverride);
	}

	storeAttachment(
		identityInput: ProductIdentity,
		input: { filename: string; mediaType: string; bytes: Uint8Array; id?: string },
	): AttachmentRecord {
		const identity = validateProductIdentity(identityInput);
		const paths = this.pathsFor(identity);
		mkdirSync(paths.attachments, { recursive: true, mode: 0o700 });
		const id = input.id ? assertIdentitySegment(input.id, "threadId") : `att_${randomUUID()}`;
		const bytesPath = assertWithin(paths.attachments, join(paths.attachments, `${id}.bin`), "attachment bytes");
		const metadataPath = assertWithin(
			paths.attachments,
			join(paths.attachments, `${id}.json`),
			"attachment metadata",
		);
		if (existsSync(bytesPath) || existsSync(metadataPath)) {
			throw new ProductStorageBoundaryError(`attachment already exists: ${id}`);
		}
		writeFileSync(bytesPath, input.bytes, { flag: "wx", mode: 0o600 });
		const record: AttachmentRecord = {
			id,
			filename: input.filename,
			mediaType: input.mediaType,
			sizeBytes: input.bytes.byteLength,
			sha256: createHash("sha256").update(input.bytes).digest("hex"),
			source: { type: "path", path: bytesPath },
		};
		atomicJsonWrite(metadataPath, {
			version: 1,
			identity,
			createdAt: Date.now(),
			record,
		} satisfies StoredAttachmentMetadata);
		void this.audit({
			type: "product_storage_audit",
			action: "attachment_store",
			identity,
			timestamp: Date.now(),
			resourceId: id,
			details: { mediaType: input.mediaType, sizeBytes: input.bytes.byteLength },
		});
		return cloneAttachment(record);
	}

	registerAttachment(
		identityInput: ProductIdentity,
		input: {
			filename: string;
			mediaType: string;
			source: Exclude<AttachmentSource, { type: "path" }>;
			id?: string;
			sizeBytes?: number;
			sha256?: string;
			metadata?: Record<string, unknown>;
		},
	): AttachmentRecord {
		const identity = validateProductIdentity(identityInput);
		const paths = this.pathsFor(identity);
		mkdirSync(paths.attachments, { recursive: true, mode: 0o700 });
		const id = input.id ? assertIdentitySegment(input.id, "threadId") : `att_${randomUUID()}`;
		const metadataPath = assertWithin(
			paths.attachments,
			join(paths.attachments, `${id}.json`),
			"attachment metadata",
		);
		if (existsSync(metadataPath)) {
			throw new ProductStorageBoundaryError(`attachment already exists: ${id}`);
		}
		const record: AttachmentRecord = {
			id,
			filename: input.filename,
			mediaType: input.mediaType,
			source: structuredClone(input.source),
			...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
			...(input.sha256 ? { sha256: input.sha256 } : {}),
			...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
		};
		atomicJsonWrite(metadataPath, {
			version: 1,
			identity,
			createdAt: Date.now(),
			record,
		} satisfies StoredAttachmentMetadata);
		void this.audit({
			type: "product_storage_audit",
			action: "attachment_store",
			identity,
			timestamp: Date.now(),
			resourceId: id,
			details: {
				mediaType: input.mediaType,
				...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
			},
		});
		return cloneAttachment(record);
	}

	getAttachment(identityInput: ProductIdentity, attachmentId: string): AttachmentRecord | undefined {
		const identity = validateProductIdentity(identityInput);
		assertIdentitySegment(attachmentId, "threadId");
		const paths = this.pathsFor(identity);
		const metadataPath = assertWithin(
			paths.attachments,
			join(paths.attachments, `${attachmentId}.json`),
			"attachment",
		);
		if (!existsSync(metadataPath)) return undefined;
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as StoredAttachmentMetadata;
		if (metadata.version !== 1 || JSON.stringify(metadata.identity) !== JSON.stringify(identity)) {
			throw new ProductStorageBoundaryError(`attachment ownership mismatch: ${attachmentId}`);
		}
		if (metadata.record.source.type === "path") {
			assertWithin(paths.attachments, metadata.record.source.path, "attachment source");
		}
		return cloneAttachment(metadata.record);
	}

	listAttachments(identityInput: ProductIdentity): AttachmentRecord[] {
		const identity = validateProductIdentity(identityInput);
		const paths = this.pathsFor(identity);
		if (!existsSync(paths.attachments)) return [];
		return readdirSync(paths.attachments)
			.filter((name) => name.endsWith(".json"))
			.flatMap((name) => {
				const record = this.getAttachment(identity, name.slice(0, -5));
				return record ? [record] : [];
			});
	}

	attachmentRegistry(identityInput: ProductIdentity): AttachmentRegistry {
		const identity = validateProductIdentity(identityInput);
		return {
			resolve: (id) => this.getAttachment(identity, id),
			read: (attachment) => {
				const owned = this.getAttachment(identity, attachment.id);
				if (!owned || owned.source.type !== "path") {
					throw new ProductStorageBoundaryError(`attachment bytes are unavailable: ${attachment.id}`);
				}
				return new Uint8Array(readFileSync(owned.source.path));
			},
			list: () => this.listAttachments(identity),
			update: (attachment) => this.updateAttachment(identity, attachment),
		};
	}

	updateAttachment(identityInput: ProductIdentity, attachment: AttachmentRecord): void {
		const identity = validateProductIdentity(identityInput);
		const existing = this.getAttachment(identity, attachment.id);
		if (!existing) throw new ProductStorageBoundaryError(`unknown attachment: ${attachment.id}`);
		const paths = this.pathsFor(identity);
		if (attachment.source.type === "path") {
			assertWithin(paths.attachments, attachment.source.path, "attachment source");
		}
		const metadataPath = join(paths.attachments, `${attachment.id}.json`);
		atomicJsonWrite(metadataPath, {
			version: 1,
			identity,
			createdAt: statSync(metadataPath).birthtimeMs,
			record: cloneAttachment(attachment),
		} satisfies StoredAttachmentMetadata);
		void this.audit({
			type: "product_storage_audit",
			action: "attachment_update",
			identity,
			timestamp: Date.now(),
			resourceId: attachment.id,
		});
	}

	deleteAttachment(identityInput: ProductIdentity, attachmentId: string): boolean {
		const identity = validateProductIdentity(identityInput);
		const existing = this.getAttachment(identity, attachmentId);
		if (!existing) return false;
		const paths = this.pathsFor(identity);
		if (existing.source.type === "path") {
			rmSync(assertWithin(paths.attachments, existing.source.path, "attachment source"), { force: true });
		}
		rmSync(join(paths.attachments, `${attachmentId}.json`), { force: true });
		void this.audit({
			type: "product_storage_audit",
			action: "attachment_delete",
			identity,
			timestamp: Date.now(),
			resourceId: attachmentId,
		});
		return true;
	}

	cleanupThread(identityInput: ProductIdentity): void {
		const identity = validateProductIdentity(identityInput);
		const paths = this.pathsFor(identity);
		rmSync(paths.thread, { recursive: true, force: true });
		void this.audit({ type: "product_storage_audit", action: "cleanup", identity, timestamp: Date.now() });
	}

	private async audit(event: ProductStorageAuditEvent): Promise<void> {
		try {
			await this.onAudit?.(structuredClone(event));
		} catch {
			// Observability hooks must not change storage semantics.
		}
	}
}

export interface ProductCredentialBackend {
	read(identity: ProductIdentity, providerId: string): Promise<Credential | undefined>;
	list(identity: ProductIdentity): Promise<readonly CredentialInfo[]>;
	modify(
		identity: ProductIdentity,
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined>;
	delete(identity: ProductIdentity, providerId: string): Promise<void>;
}

export class ScopedProductCredentialStore implements CredentialStore {
	readonly identity: ProductIdentity;
	private readonly backend: ProductCredentialBackend;

	constructor(backend: ProductCredentialBackend, identity: ProductIdentity) {
		this.backend = backend;
		this.identity = validateProductIdentity(identity);
	}

	read(providerId: string): Promise<Credential | undefined> {
		return this.backend.read(this.identity, providerId);
	}

	list(): Promise<readonly CredentialInfo[]> {
		return this.backend.list(this.identity);
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.backend.modify(this.identity, providerId, fn);
	}

	delete(providerId: string): Promise<void> {
		return this.backend.delete(this.identity, providerId);
	}
}

function credentialScope(identity: ProductIdentity): string {
	return `${identity.tenantId}/${identity.userId}/${identity.agentId}/${identity.threadId}`;
}

export class InMemoryProductCredentialBackend implements ProductCredentialBackend {
	private readonly credentials = new Map<string, Map<string, Credential>>();
	private readonly chains = new Map<string, Promise<unknown>>();

	private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(task);
		this.chains.set(
			key,
			next.catch(() => {}),
		);
		return next;
	}

	async read(identity: ProductIdentity, providerId: string): Promise<Credential | undefined> {
		return structuredClone(this.credentials.get(credentialScope(validateProductIdentity(identity)))?.get(providerId));
	}

	async list(identity: ProductIdentity): Promise<readonly CredentialInfo[]> {
		return [...(this.credentials.get(credentialScope(validateProductIdentity(identity))) ?? new Map())].map(
			([providerId, credential]) => ({ providerId, type: credential.type }),
		);
	}

	modify(
		identityInput: ProductIdentity,
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const identity = validateProductIdentity(identityInput);
		const scope = credentialScope(identity);
		return this.enqueue(`${scope}/${providerId}`, async () => {
			const scoped = this.credentials.get(scope) ?? new Map<string, Credential>();
			const current = scoped.get(providerId);
			const next = await fn(current ? structuredClone(current) : undefined);
			if (next) scoped.set(providerId, structuredClone(next));
			this.credentials.set(scope, scoped);
			return structuredClone(next ?? current);
		});
	}

	delete(identityInput: ProductIdentity, providerId: string): Promise<void> {
		const identity = validateProductIdentity(identityInput);
		const scope = credentialScope(identity);
		return this.enqueue(`${scope}/${providerId}`, async () => {
			this.credentials.get(scope)?.delete(providerId);
		});
	}
}
