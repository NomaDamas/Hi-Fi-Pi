import type { Api, AttachmentRecord, AttachmentSource, AttachmentSourcePolicy, ProviderId } from "./types.ts";

const DEFAULT_URL_PROTOCOLS = ["https:"];
const DEFAULT_CLOUD_PROTOCOLS = ["gs:", "s3:", "https:"];

export class AttachmentSourcePolicyError extends Error {
	constructor(attachment: Pick<AttachmentRecord, "id" | "filename">, reason: string) {
		super(`Attachment source policy rejected ${attachment.id} (${attachment.filename}): ${reason}`);
		this.name = "AttachmentSourcePolicyError";
	}
}

export interface AttachmentSourceContext {
	provider: ProviderId;
	api: Api;
	baseUrl: string;
}

function normalizedProtocols(protocols: readonly string[]): Set<string> {
	return new Set(protocols.map((protocol) => (protocol.endsWith(":") ? protocol : `${protocol}:`).toLowerCase()));
}

function isPrivateIpv4(hostname: string): boolean {
	const octets = hostname.split(".").map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
		return false;
	}
	const [first = 0, second = 0] = octets;
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		first >= 224
	);
}

function isPrivateHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized === "::1" ||
		normalized.startsWith("fe80:") ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized === "169.254.169.254" ||
		isPrivateIpv4(normalized)
	);
}

function hostMatches(hostname: string, pattern: string): boolean {
	const normalized = pattern.toLowerCase();
	if (normalized.startsWith("*.")) {
		const suffix = normalized.slice(1);
		return hostname.endsWith(suffix) && hostname.length > suffix.length;
	}
	return hostname === normalized;
}

function validateNetworkUrl(
	attachment: AttachmentRecord,
	value: string,
	protocols: readonly string[],
	policy: AttachmentSourcePolicy,
): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AttachmentSourcePolicyError(attachment, "source is not a valid absolute URI");
	}
	if (!normalizedProtocols(protocols).has(url.protocol.toLowerCase())) {
		throw new AttachmentSourcePolicyError(attachment, `protocol ${url.protocol} is not allowed`);
	}
	if (url.username || url.password) {
		throw new AttachmentSourcePolicyError(attachment, "embedded URL credentials are not allowed");
	}
	const hostname = url.hostname.toLowerCase();
	if ((policy.denyPrivateNetwork ?? true) && isPrivateHostname(hostname)) {
		throw new AttachmentSourcePolicyError(attachment, `private-network host ${hostname} is not allowed`);
	}
	if (policy.deniedHosts?.some((pattern) => hostMatches(hostname, pattern))) {
		throw new AttachmentSourcePolicyError(attachment, `host ${hostname} is denied`);
	}
	if (policy.allowedHosts && !policy.allowedHosts.some((pattern) => hostMatches(hostname, pattern))) {
		throw new AttachmentSourcePolicyError(attachment, `host ${hostname} is not allow-listed`);
	}
	url.hash = "";
	return url.toString();
}

function assertOwnership(
	attachment: AttachmentRecord,
	source: Extract<AttachmentSource, { type: "cloud-uri" | "provider-file" }>,
	context: AttachmentSourceContext,
): void {
	if (source.provider && source.provider !== context.provider) {
		const kind = source.type === "provider-file" ? "provider file" : "cloud URI";
		throw new AttachmentSourcePolicyError(attachment, `${kind} belongs to ${source.provider}`);
	}
	if (source.api && source.api !== context.api) {
		const kind = source.type === "provider-file" ? "provider file" : "cloud URI";
		throw new AttachmentSourcePolicyError(attachment, `${kind} belongs to transport ${source.api}`);
	}
	if (source.endpoint && source.endpoint.replace(/\/+$/, "") !== context.baseUrl.replace(/\/+$/, "")) {
		const kind = source.type === "provider-file" ? "provider file" : "cloud URI";
		throw new AttachmentSourcePolicyError(attachment, `${kind} belongs to endpoint ${source.endpoint}`);
	}
}

export function validateAttachmentSource(
	attachment: AttachmentRecord,
	context: AttachmentSourceContext,
	policy: AttachmentSourcePolicy = {},
): AttachmentSource {
	if (
		policy.maximumBytes !== undefined &&
		attachment.sizeBytes !== undefined &&
		attachment.sizeBytes > policy.maximumBytes
	) {
		throw new AttachmentSourcePolicyError(
			attachment,
			`${attachment.sizeBytes} bytes exceeds policy limit ${policy.maximumBytes} bytes`,
		);
	}
	const source = attachment.source;
	if (
		(source.type === "url" || source.type === "cloud-uri") &&
		source.expiresAt !== undefined &&
		source.expiresAt <= Date.now()
	) {
		throw new AttachmentSourcePolicyError(attachment, "remote source has expired");
	}
	if (source.type === "url") {
		return {
			...source,
			url: validateNetworkUrl(attachment, source.url, policy.allowedUrlProtocols ?? DEFAULT_URL_PROTOCOLS, policy),
		};
	}
	if (source.type === "cloud-uri") {
		assertOwnership(attachment, source, context);
		const parsedProtocol = source.uri.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1];
		if (!parsedProtocol) throw new AttachmentSourcePolicyError(attachment, "cloud source is not an absolute URI");
		const allowed = normalizedProtocols(policy.allowedCloudProtocols ?? DEFAULT_CLOUD_PROTOCOLS);
		if (!allowed.has(`${parsedProtocol.toLowerCase()}:`)) {
			throw new AttachmentSourcePolicyError(attachment, `cloud protocol ${parsedProtocol}: is not allowed`);
		}
		if (parsedProtocol.toLowerCase() === "https") {
			return {
				...source,
				uri: validateNetworkUrl(
					attachment,
					source.uri,
					policy.allowedCloudProtocols ?? DEFAULT_CLOUD_PROTOCOLS,
					policy,
				),
			};
		}
		return source;
	}
	if (source.type === "provider-file") assertOwnership(attachment, source, context);
	return source;
}

export function sanitizeAttachmentSourceForExport(source: AttachmentSource): AttachmentSource {
	if (source.type !== "url" && source.type !== "cloud-uri") return structuredClone(source);
	const value = source.type === "url" ? source.url : source.uri;
	if (!/^https?:\/\//i.test(value)) return structuredClone(source);
	try {
		const url = new URL(value);
		if ([...url.searchParams.keys()].length > 0) {
			url.search = "";
			url.searchParams.set("redacted", "true");
		}
		url.username = "";
		url.password = "";
		return source.type === "url" ? { ...source, url: url.toString() } : { ...source, uri: url.toString() };
	} catch {
		return source.type === "url"
			? { ...source, url: "[redacted invalid URL]" }
			: { ...source, uri: "[redacted invalid URL]" };
	}
}
