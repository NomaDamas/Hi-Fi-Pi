import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import {
	type Api,
	type AttachmentRecord,
	type AttachmentSourceContext,
	type AttachmentSourcePolicy,
	type ProviderId,
	validateAttachmentSource,
} from "@earendil-works/pi-ai";
import { type ProductIdentity, validateProductIdentity } from "./storage.ts";

export type ProductExtensionCapability = "filesystem" | "process" | "network" | "tui";

export interface ProductExtensionDescriptor {
	source: string;
	version?: string;
	integrity?: string;
	capabilities?: ProductExtensionCapability[];
}

export interface ProductExtensionAllowRule {
	source: string;
	versions?: string[];
	integrities?: string[];
}

export interface ProductAttachmentPolicy extends AttachmentSourcePolicy {
	allowedLocalRoots?: string[];
	maximumCount?: number;
	maximumAggregateBytes?: number;
}

export interface ProductExtensionPolicy {
	allow: ProductExtensionAllowRule[];
	requireVersion?: boolean;
	requireIntegrity?: boolean;
	deniedCapabilities?: ProductExtensionCapability[];
}

export interface ProductPolicy {
	attachments?: ProductAttachmentPolicy;
	extensions?: ProductExtensionPolicy;
}

export interface ProductPolicyAuditEvent {
	type: "product_policy_audit";
	action: "allow" | "deny";
	domain: "attachment" | "attachment_redirect" | "extension";
	code: ProductPolicyDenialCode | "allowed";
	identity: ProductIdentity;
	timestamp: number;
	resourceId?: string;
	details?: Record<string, string | number | boolean>;
}

export type ProductPolicyDenialCode =
	| "attachment_owner_mismatch"
	| "attachment_source_missing"
	| "attachment_local_root_denied"
	| "attachment_limit_exceeded"
	| "attachment_source_denied"
	| "attachment_redirect_denied"
	| "extension_source_denied"
	| "extension_version_denied"
	| "extension_integrity_denied"
	| "extension_capability_denied";

export class ProductPolicyDenialError extends Error {
	readonly code: ProductPolicyDenialCode;
	readonly domain: ProductPolicyAuditEvent["domain"];
	readonly resourceId?: string;

	constructor(
		code: ProductPolicyDenialCode,
		domain: ProductPolicyAuditEvent["domain"],
		message: string,
		resourceId?: string,
	) {
		super(`Product policy denied ${domain}: ${message}`);
		this.name = "ProductPolicyDenialError";
		this.code = code;
		this.domain = domain;
		this.resourceId = resourceId;
	}
}

export interface ProductAttachmentOwner {
	identity: ProductIdentity;
	record: AttachmentRecord;
}

export interface ProductAttachmentRequestContext {
	provider: ProviderId;
	api: Api;
	baseUrl: string;
}

export interface ProductRedirectContext extends ProductAttachmentRequestContext {
	attachment: ProductAttachmentOwner;
	from: string;
	to: string;
	redirectCount: number;
}

export interface ProductPolicyEnforcerOptions {
	policy?: ProductPolicy;
	onAudit?: (event: ProductPolicyAuditEvent) => void | Promise<void>;
}

function isWithin(root: string, candidate: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedCandidate = resolve(candidate);
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function identitiesEqual(left: ProductIdentity, right: ProductIdentity): boolean {
	return (
		left.tenantId === right.tenantId &&
		left.userId === right.userId &&
		left.agentId === right.agentId &&
		left.threadId === right.threadId
	);
}

function normalizedExtensionSource(source: string): string {
	return isAbsolute(source) ? resolve(source) : source;
}

function sourceMatches(source: string, rule: string): boolean {
	const normalizedSource = normalizedExtensionSource(source);
	const normalizedRule = normalizedExtensionSource(rule);
	if (normalizedRule.endsWith("/**")) {
		const root = normalizedRule.slice(0, -3);
		return isWithin(root, normalizedSource);
	}
	return normalizedSource === normalizedRule;
}

function sha256Integrity(path: string): string {
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new ProductPolicyDenialError(
			"extension_integrity_denied",
			"extension",
			"integrity verification requires a regular file",
		);
	}
	return `sha256-${createHash("sha256").update(readFileSync(path)).digest("base64")}`;
}

function discoverPackageVersion(path: string): string | undefined {
	let directory = statSync(path).isDirectory() ? path : dirname(path);
	for (;;) {
		const packagePath = resolve(directory, "package.json");
		if (existsSync(packagePath) && statSync(packagePath).isFile()) {
			try {
				const value = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
				return typeof value.version === "string" ? value.version : undefined;
			} catch {
				return undefined;
			}
		}
		const parent = resolve(directory, "..");
		if (parent === directory) return undefined;
		directory = parent;
	}
}

/**
 * Enforces product-owned input and resource policy before Pi's provider and
 * extension loaders run. Extension capability checks are admission controls,
 * not an OS sandbox: untrusted code still requires an external process or
 * container sandbox supplied by the embedding product.
 */
export class ProductPolicyEnforcer {
	readonly policy: ProductPolicy;
	private readonly onAudit?: ProductPolicyEnforcerOptions["onAudit"];

	constructor(options: ProductPolicyEnforcerOptions = {}) {
		this.policy = structuredClone(options.policy ?? {});
		this.onAudit = options.onAudit;
	}

	assertAttachments(
		requestIdentityInput: ProductIdentity,
		attachments: readonly ProductAttachmentOwner[],
		context: ProductAttachmentRequestContext,
	): void {
		const requestIdentity = validateProductIdentity(requestIdentityInput);
		const policy = this.policy.attachments ?? {};
		if (
			(policy.maximumBytes !== undefined || policy.maximumAggregateBytes !== undefined) &&
			attachments.some((item) => item.record.sizeBytes === undefined)
		) {
			this.deny(
				requestIdentity,
				new ProductPolicyDenialError(
					"attachment_limit_exceeded",
					"attachment",
					"attachment size is required when byte limits are configured",
				),
			);
		}
		if (policy.maximumCount !== undefined && attachments.length > policy.maximumCount) {
			this.deny(
				requestIdentity,
				new ProductPolicyDenialError(
					"attachment_limit_exceeded",
					"attachment",
					`${attachments.length} attachments exceeds limit ${policy.maximumCount}`,
				),
			);
		}
		const aggregateBytes = attachments.reduce((total, item) => total + (item.record.sizeBytes ?? 0), 0);
		if (policy.maximumAggregateBytes !== undefined && aggregateBytes > policy.maximumAggregateBytes) {
			this.deny(
				requestIdentity,
				new ProductPolicyDenialError(
					"attachment_limit_exceeded",
					"attachment",
					`aggregate size ${aggregateBytes} exceeds limit ${policy.maximumAggregateBytes}`,
				),
			);
		}
		for (const attachment of attachments) this.assertAttachment(requestIdentity, attachment, context);
	}

	assertAttachment(
		requestIdentityInput: ProductIdentity,
		attachment: ProductAttachmentOwner,
		context: ProductAttachmentRequestContext,
	): void {
		const requestIdentity = validateProductIdentity(requestIdentityInput);
		const ownerIdentity = validateProductIdentity(attachment.identity);
		if (!identitiesEqual(requestIdentity, ownerIdentity)) {
			this.deny(
				requestIdentity,
				new ProductPolicyDenialError(
					"attachment_owner_mismatch",
					"attachment",
					"attachment belongs to another product identity",
					attachment.record.id,
				),
			);
		}
		const policy = this.policy.attachments ?? {};
		if (policy.maximumBytes !== undefined && attachment.record.sizeBytes === undefined) {
			this.deny(
				requestIdentity,
				new ProductPolicyDenialError(
					"attachment_limit_exceeded",
					"attachment",
					"attachment size is required when a byte limit is configured",
					attachment.record.id,
				),
			);
		}
		if (attachment.record.source.type === "path") {
			this.assertLocalAttachment(requestIdentity, attachment.record, policy);
		}
		try {
			validateAttachmentSource(attachment.record, context as AttachmentSourceContext, policy);
		} catch (error) {
			this.deny(
				requestIdentity,
				new ProductPolicyDenialError(
					"attachment_source_denied",
					"attachment",
					error instanceof Error ? error.message : String(error),
					attachment.record.id,
				),
			);
		}
		this.allow(requestIdentity, "attachment", attachment.record.id, {
			mediaType: attachment.record.mediaType,
			sizeBytes: attachment.record.sizeBytes ?? 0,
		});
	}

	assertRedirect(requestIdentityInput: ProductIdentity, redirect: ProductRedirectContext): void {
		const requestIdentity = validateProductIdentity(requestIdentityInput);
		const policy = this.policy.attachments ?? {};
		if (!(policy.allowRedirects ?? false)) {
			this.deny(
				requestIdentity,
				new ProductPolicyDenialError(
					"attachment_redirect_denied",
					"attachment_redirect",
					"redirects are disabled",
					redirect.attachment.record.id,
				),
			);
		}
		if (redirect.redirectCount > (policy.maximumRedirects ?? 0)) {
			this.deny(
				requestIdentity,
				new ProductPolicyDenialError(
					"attachment_redirect_denied",
					"attachment_redirect",
					`redirect count ${redirect.redirectCount} exceeds limit ${policy.maximumRedirects ?? 0}`,
					redirect.attachment.record.id,
				),
			);
		}
		this.assertAttachment(
			requestIdentity,
			{
				...redirect.attachment,
				record: { ...redirect.attachment.record, source: { type: "url", url: redirect.to } },
			},
			redirect,
		);
		this.allow(requestIdentity, "attachment_redirect", redirect.attachment.record.id, {
			redirectCount: redirect.redirectCount,
		});
	}

	assertExtensions(requestIdentityInput: ProductIdentity, extensions: readonly ProductExtensionDescriptor[]): void {
		const identity = validateProductIdentity(requestIdentityInput);
		const policy = this.policy.extensions;
		if (!policy && extensions.length > 0) {
			this.deny(
				identity,
				new ProductPolicyDenialError(
					"extension_source_denied",
					"extension",
					"no extension allow-list is configured",
				),
			);
		}
		for (const extension of extensions) {
			const source = resolve(extension.source);
			const rule = policy?.allow.find((candidate) => sourceMatches(source, candidate.source));
			if (!rule) {
				this.deny(
					identity,
					new ProductPolicyDenialError(
						"extension_source_denied",
						"extension",
						"source is not allow-listed",
						source,
					),
				);
			}
			if (!existsSync(source)) {
				this.deny(
					identity,
					new ProductPolicyDenialError("extension_source_denied", "extension", "source does not exist", source),
				);
			}
			const discoveredVersion = discoverPackageVersion(source);
			const version = extension.version ?? discoveredVersion;
			if (
				(policy?.requireVersion && !version) ||
				(rule.versions && (!version || !rule.versions.includes(version)))
			) {
				this.deny(
					identity,
					new ProductPolicyDenialError(
						"extension_version_denied",
						"extension",
						"version is missing or not allow-listed",
						source,
					),
				);
			}
			if (extension.version && discoveredVersion && extension.version !== discoveredVersion) {
				this.deny(
					identity,
					new ProductPolicyDenialError(
						"extension_version_denied",
						"extension",
						"declared version does not match package metadata",
						source,
					),
				);
			}
			const actualIntegrity =
				extension.integrity || policy?.requireIntegrity || rule.integrities ? sha256Integrity(source) : undefined;
			if (extension.integrity && extension.integrity !== actualIntegrity) {
				this.deny(
					identity,
					new ProductPolicyDenialError(
						"extension_integrity_denied",
						"extension",
						"declared integrity does not match source bytes",
						source,
					),
				);
			}
			if (
				(policy?.requireIntegrity && !actualIntegrity) ||
				(rule.integrities && (!actualIntegrity || !rule.integrities.includes(actualIntegrity)))
			) {
				this.deny(
					identity,
					new ProductPolicyDenialError(
						"extension_integrity_denied",
						"extension",
						"integrity is missing or not allow-listed",
						source,
					),
				);
			}
			const deniedCapability = extension.capabilities?.find((capability) =>
				policy?.deniedCapabilities?.includes(capability),
			);
			if (deniedCapability) {
				this.deny(
					identity,
					new ProductPolicyDenialError(
						"extension_capability_denied",
						"extension",
						`capability ${deniedCapability} is disabled`,
						source,
					),
				);
			}
			this.allow(identity, "extension", source, {
				...(version ? { version } : {}),
				integrityVerified: Boolean(actualIntegrity),
			});
		}
	}

	private assertLocalAttachment(
		identity: ProductIdentity,
		attachment: AttachmentRecord,
		policy: ProductAttachmentPolicy,
	): void {
		if (attachment.source.type !== "path") return;
		if (!existsSync(attachment.source.path)) {
			this.deny(
				identity,
				new ProductPolicyDenialError(
					"attachment_source_missing",
					"attachment",
					"local source does not exist",
					attachment.id,
				),
			);
		}
		const actualPath = realpathSync(attachment.source.path);
		if (!statSync(actualPath).isFile()) {
			this.deny(
				identity,
				new ProductPolicyDenialError(
					"attachment_source_denied",
					"attachment",
					"local source is not a regular file",
					attachment.id,
				),
			);
		}
		const roots = policy.allowedLocalRoots ?? [];
		const allowed = roots.some((root) => {
			if (!existsSync(root)) return false;
			const actualRoot = realpathSync(root);
			return isWithin(actualRoot, actualPath);
		});
		if (!allowed) {
			this.deny(
				identity,
				new ProductPolicyDenialError(
					"attachment_local_root_denied",
					"attachment",
					"local source is outside configured roots",
					attachment.id,
				),
			);
		}
		const sizeBytes = statSync(actualPath).size;
		if (policy.maximumBytes !== undefined && sizeBytes > policy.maximumBytes) {
			this.deny(
				identity,
				new ProductPolicyDenialError(
					"attachment_limit_exceeded",
					"attachment",
					`source size ${sizeBytes} exceeds limit ${policy.maximumBytes}`,
					attachment.id,
				),
			);
		}
	}

	private deny(identity: ProductIdentity, error: ProductPolicyDenialError): never {
		void this.audit({
			type: "product_policy_audit",
			action: "deny",
			domain: error.domain,
			code: error.code,
			identity,
			timestamp: Date.now(),
			resourceId: error.resourceId ? basename(error.resourceId) : undefined,
		});
		throw error;
	}

	private allow(
		identity: ProductIdentity,
		domain: ProductPolicyAuditEvent["domain"],
		resourceId?: string,
		details?: ProductPolicyAuditEvent["details"],
	): void {
		void this.audit({
			type: "product_policy_audit",
			action: "allow",
			domain,
			code: "allowed",
			identity,
			timestamp: Date.now(),
			resourceId: resourceId ? basename(resourceId) : undefined,
			details,
		});
	}

	private async audit(event: ProductPolicyAuditEvent): Promise<void> {
		try {
			await this.onAudit?.(structuredClone(event));
		} catch {
			// Observability hooks must not change policy decisions.
		}
	}
}
