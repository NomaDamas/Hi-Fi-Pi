import { describe, expect, it } from "vitest";
import {
	AttachmentSourcePolicyError,
	sanitizeAttachmentSourceForExport,
	validateAttachmentSource,
} from "../src/attachment-sources.ts";
import type { AttachmentRecord } from "../src/types.ts";

const context = { provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" } as const;

function remote(url: string): AttachmentRecord {
	return {
		id: "att_remote",
		filename: "paper.pdf",
		mediaType: "application/pdf",
		source: { type: "url", url },
	};
}

describe("attachment source policy", () => {
	it.each([
		"http://example.com/paper.pdf",
		"https://localhost/paper.pdf",
		"https://127.0.0.1/paper.pdf",
		"https://10.0.0.1/paper.pdf",
		"https://172.16.0.1/paper.pdf",
		"https://192.168.1.1/paper.pdf",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/paper.pdf",
		"https://user:secret@example.com/paper.pdf",
	])("rejects unsafe remote source %s without fetching it", (url) => {
		expect(() => validateAttachmentSource(remote(url), context)).toThrow(AttachmentSourcePolicyError);
	});

	it("normalizes a public HTTPS source and strips fragments", () => {
		expect(validateAttachmentSource(remote("https://EXAMPLE.com/paper.pdf#page=2"), context)).toEqual({
			type: "url",
			url: "https://example.com/paper.pdf",
		});
	});

	it("enforces host allow lists, size limits and expiration", () => {
		expect(() =>
			validateAttachmentSource(remote("https://example.com/paper.pdf"), context, {
				allowedHosts: ["files.example.org"],
			}),
		).toThrow(/not allow-listed/i);
		const oversized = { ...remote("https://example.com/paper.pdf"), sizeBytes: 11 };
		expect(() => validateAttachmentSource(oversized, context, { maximumBytes: 10 })).toThrow(/exceeds policy limit/i);
		const expired: AttachmentRecord = {
			...remote("https://example.com/paper.pdf"),
			source: { type: "url", url: "https://example.com/paper.pdf", expiresAt: Date.now() - 1 },
		};
		expect(() => validateAttachmentSource(expired, context)).toThrow(/expired/i);
	});

	it("isolates provider files by provider, transport and endpoint", () => {
		const record: AttachmentRecord = {
			id: "att_file",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: {
				type: "provider-file",
				provider: "openai",
				api: "openai-responses",
				endpoint: "https://proxy.example/v1",
				fileId: "file_123",
			},
		};
		expect(() => validateAttachmentSource(record, context)).toThrow(/belongs to endpoint/i);
	});

	it("redacts signed query material from exported attachment sources", () => {
		expect(
			sanitizeAttachmentSourceForExport({
				type: "url",
				url: "https://files.example.com/paper.pdf?X-Amz-Signature=secret&download=1",
			}),
		).toEqual({ type: "url", url: "https://files.example.com/paper.pdf?redacted=true" });
	});
});
