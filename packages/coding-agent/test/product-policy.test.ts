import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentRecord } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ProductExtensionDescriptor,
	ProductPolicyDenialError,
	ProductPolicyEnforcer,
} from "../src/product/policy.ts";
import type { ProductIdentity } from "../src/product/storage.ts";

describe("product policy enforcement", () => {
	let directory: string;
	let allowedRoot: string;
	let outsideRoot: string;
	const identity: ProductIdentity = {
		tenantId: "tenant-a",
		userId: "user-a",
		agentId: "research",
		threadId: "thread-a",
	};
	const context = {
		provider: "openai" as const,
		api: "openai-responses" as const,
		baseUrl: "https://api.openai.com/v1",
	};

	beforeEach(() => {
		directory = join(tmpdir(), `hifi-product-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		allowedRoot = join(directory, "allowed");
		outsideRoot = join(directory, "outside");
		mkdirSync(allowedRoot, { recursive: true });
		mkdirSync(outsideRoot, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	});

	function localAttachment(id: string, path: string, sizeBytes = 4): AttachmentRecord {
		return { id, filename: `${id}.pdf`, mediaType: "application/pdf", sizeBytes, source: { type: "path", path } };
	}

	it("allows local files only under real allow-listed roots and rejects symlink escapes", () => {
		const inside = join(allowedRoot, "paper.pdf");
		const outside = join(outsideRoot, "secret.pdf");
		const symlink = join(allowedRoot, "link.pdf");
		writeFileSync(inside, "%PDF");
		writeFileSync(outside, "secret");
		symlinkSync(outside, symlink);
		const policy = new ProductPolicyEnforcer({
			policy: { attachments: { allowedLocalRoots: [allowedRoot], maximumBytes: 16 } },
		});

		expect(() =>
			policy.assertAttachment(identity, { identity, record: localAttachment("inside", inside) }, context),
		).not.toThrow();
		expect(() =>
			policy.assertAttachment(identity, { identity, record: localAttachment("outside", outside) }, context),
		).toThrow("outside configured roots");
		expect(() =>
			policy.assertAttachment(identity, { identity, record: localAttachment("symlink", symlink) }, context),
		).toThrow("outside configured roots");
	});

	it("enforces ownership, count, aggregate bytes and actual local size", () => {
		const firstPath = join(allowedRoot, "first.pdf");
		const secondPath = join(allowedRoot, "second.pdf");
		writeFileSync(firstPath, "12345");
		writeFileSync(secondPath, "67890");
		const first = localAttachment("first", firstPath, 5);
		const second = localAttachment("second", secondPath, 5);
		const policy = new ProductPolicyEnforcer({
			policy: {
				attachments: {
					allowedLocalRoots: [allowedRoot],
					maximumBytes: 5,
					maximumCount: 1,
					maximumAggregateBytes: 8,
				},
			},
		});

		expect(() => policy.assertAttachments(identity, [{ identity, record: first }], context)).not.toThrow();
		expect(() =>
			policy.assertAttachments(
				identity,
				[
					{ identity, record: first },
					{ identity, record: second },
				],
				context,
			),
		).toThrow("exceeds limit");
		expect(() =>
			policy.assertAttachment(identity, { identity: { ...identity, tenantId: "tenant-b" }, record: first }, context),
		).toThrow("another product identity");

		writeFileSync(firstPath, "123456");
		expect(() => policy.assertAttachment(identity, { identity, record: first }, context)).toThrow(
			"source size 6 exceeds limit 5",
		);
	});

	it("applies URL host and redirect policy on every hop", () => {
		const record: AttachmentRecord = {
			id: "remote",
			filename: "remote.pdf",
			mediaType: "application/pdf",
			source: { type: "url", url: "https://files.example.com/paper.pdf" },
		};
		const strict = new ProductPolicyEnforcer({
			policy: { attachments: { allowedHosts: ["files.example.com"] } },
		});
		expect(() => strict.assertAttachment(identity, { identity, record }, context)).not.toThrow();
		expect(() =>
			strict.assertAttachment(
				identity,
				{ identity, record: { ...record, source: { type: "url", url: "https://127.0.0.1/file" } } },
				context,
			),
		).toThrow("not allowed");
		expect(() =>
			strict.assertRedirect(identity, {
				attachment: { identity, record },
				from: "https://files.example.com/paper.pdf",
				to: "https://files.example.com/next.pdf",
				redirectCount: 1,
				...context,
			}),
		).toThrow("redirects are disabled");

		const redirects = new ProductPolicyEnforcer({
			policy: {
				attachments: { allowedHosts: ["files.example.com"], allowRedirects: true, maximumRedirects: 2 },
			},
		});
		expect(() =>
			redirects.assertRedirect(identity, {
				attachment: { identity, record },
				from: "https://files.example.com/paper.pdf",
				to: "https://evil.example.net/next.pdf",
				redirectCount: 1,
				...context,
			}),
		).toThrow("not allow-listed");
	});

	it("allow-lists extension source, version and integrity and denies disabled capabilities", () => {
		const extensionPath = join(directory, "extension.ts");
		writeFileSync(extensionPath, "export default function extension() {}\n");
		const integrity = `sha256-${createHash("sha256").update(readFile(extensionPath)).digest("base64")}`;
		const descriptor: ProductExtensionDescriptor = {
			source: extensionPath,
			version: "1.0.0",
			integrity,
			capabilities: ["filesystem"],
		};
		const policy = new ProductPolicyEnforcer({
			policy: {
				extensions: {
					allow: [{ source: extensionPath, versions: ["1.0.0"], integrities: [integrity] }],
					requireVersion: true,
					requireIntegrity: true,
					deniedCapabilities: ["network"],
				},
			},
		});
		expect(() => policy.assertExtensions(identity, [descriptor])).not.toThrow();
		expect(() => policy.assertExtensions(identity, [{ ...descriptor, version: "2.0.0" }])).toThrow(
			"version is missing or not allow-listed",
		);
		expect(() => policy.assertExtensions(identity, [{ ...descriptor, capabilities: ["network"] }])).toThrow(
			"capability network is disabled",
		);
		expect(() => policy.assertExtensions(identity, [{ ...descriptor, integrity: "sha256-invalid" }])).toThrow(
			ProductPolicyDenialError,
		);
	});
});

function readFile(path: string): Uint8Array {
	return new Uint8Array(readFileSync(path));
}
