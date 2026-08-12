import type { Api, AttachmentRecord, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	resolveAttachmentRuntime,
	stripLegacyAttachmentRuntimeMetadata,
} from "../../../src/core/attachments/attachment-runtime.ts";

const openAiModel = {
	provider: "openai",
	id: "gpt-test",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	input: ["text", "image"],
} as Model<Api>;

const pdf: AttachmentRecord = {
	id: "att_pdf",
	filename: "paper.pdf",
	mediaType: "application/pdf",
	sha256: "sha256-pdf",
	source: { type: "path", path: "/documents/paper.pdf" },
	metadata: {
		vendorTag: "preserve-me",
		sourceAvailable: false,
		preparationStatus: "unsupported",
		nativeMethod: "stale-method",
		unsupportedReason: "stale-reason",
	},
};

describe("Issue 63 attachment runtime-state contracts", () => {
	it("keeps source and transport state separate when no model is selected", () => {
		const resolved = resolveAttachmentRuntime(pdf, {
			source: { status: "available" },
			now: 1_700_000_000_000,
		});

		expect(resolved).toEqual({
			record: pdf,
			state: {
				source: { status: "available" },
				transport: { status: "unresolved" },
			},
		});
	});

	it("ignores deprecated presentation metadata while resolving current state", () => {
		const before = structuredClone(pdf);
		const resolved = resolveAttachmentRuntime(pdf, {
			model: openAiModel,
			source: { status: "available" },
			now: 1_700_000_000_000,
		});

		expect(resolved.state).toEqual({
			source: { status: "available" },
			transport: { status: "ready", nativeMethod: "input_file" },
		});
		expect(pdf).toEqual(before);
	});

	it("reports an unexpired matching remote as uploaded", () => {
		const withRemote: AttachmentRecord = {
			...pdf,
			remotes: {
				openai: {
					provider: "openai",
					api: "openai-responses",
					endpoint: "https://api.openai.com/v1/",
					fileId: "file_123",
					uploadedAt: 1,
					expiresAt: 1_800_000_000_000,
					sourceSha256: pdf.sha256,
				},
			},
		};

		const resolved = resolveAttachmentRuntime(withRemote, {
			model: openAiModel,
			source: { status: "available" },
			now: 1_700_000_000_000,
		});

		expect(resolved.state.transport).toEqual({ status: "uploaded", nativeMethod: "input_file" });
	});

	it("does not reuse expired, deleted, endpoint-mismatched, or stale-source remotes", () => {
		for (const remote of [
			{ expiresAt: 1_600_000_000_000 },
			{ state: "deleted" as const },
			{ endpoint: "https://proxy.example.com/v1" },
			{ sourceSha256: "different-content" },
		]) {
			const record: AttachmentRecord = {
				...pdf,
				remotes: {
					openai: {
						provider: "openai",
						api: "openai-responses",
						fileId: "file_stale",
						uploadedAt: 1,
						...remote,
					},
				},
			};

			const resolved = resolveAttachmentRuntime(record, {
				model: openAiModel,
				source: { status: "available" },
				now: 1_700_000_000_000,
			});
			expect(resolved.state.transport.status).toBe("ready");
		}
	});

	it("reports unsupported transport independently from source availability", () => {
		const video: AttachmentRecord = {
			id: "att_video",
			filename: "demo.mp4",
			mediaType: "video/mp4",
			source: { type: "path", path: "/missing/demo.mp4" },
		};
		const anthropicModel = {
			provider: "anthropic",
			id: "claude-test",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			input: ["text", "image"],
		} as Model<Api>;

		const resolved = resolveAttachmentRuntime(video, {
			model: anthropicModel,
			source: { status: "missing", reason: "Local source is unavailable." },
			now: 1_700_000_000_000,
		});

		expect(resolved.state.source.status).toBe("missing");
		expect(resolved.state.transport.status).toBe("unsupported");
		expect(resolved.state.transport.reason).toContain("enabled media types");
	});

	it("strips only deprecated runtime metadata keys and preserves opaque vendor metadata", () => {
		const sanitized = stripLegacyAttachmentRuntimeMetadata(pdf);

		expect(sanitized.metadata).toEqual({ vendorTag: "preserve-me" });
		expect(pdf.metadata).toHaveProperty("preparationStatus", "unsupported");
	});
});
