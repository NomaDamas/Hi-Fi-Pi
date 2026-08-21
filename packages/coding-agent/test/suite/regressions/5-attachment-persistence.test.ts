import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AttachmentRecord,
	fauxAssistantMessage,
	PortabilityConfirmationRequiredError,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { exportFromFile } from "../../../src/core/export-html/index.ts";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

async function createPdfHarness(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
	const harness = await createHarness(options);
	for (const model of harness.models) {
		model.nativeInputs = {
			profile: `${model.id}-issue-5-pdf`,
			capabilities: [
				{
					id: "issue-5-pdf",
					supported: true,
					mediaTypes: ["application/pdf"],
					sources: ["inline"],
					wireKinds: { inline: "faux-file" },
					provenance: "configured",
				},
			],
		};
	}
	return harness;
}

const attachment: AttachmentRecord = {
	id: "att_paper",
	filename: "paper.pdf",
	mediaType: "application/pdf",
	sizeBytes: 2048,
	sha256: "abc123",
	source: { type: "path", path: "/missing/paper.pdf" },
	remotes: {
		"openai:openai-responses": {
			provider: "openai",
			api: "openai-responses",
			fileId: "file_openai_123",
			uploadedAt: 1_700_000_000_000,
		},
	},
};

type AttachmentSessionManager = SessionManager & {
	appendAttachment(record: AttachmentRecord): string;
	updateAttachment(record: AttachmentRecord): string;
	getAttachment(id: string): AttachmentRecord | undefined;
	getAttachments(): AttachmentRecord[];
	findDanglingAttachmentReferences(): Array<{ attachmentId: string; messageEntryId: string }>;
};

function withAttachmentApi(manager: SessionManager): AttachmentSessionManager {
	return manager as AttachmentSessionManager;
}

function userMessage(text: string, attachmentId?: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		...(attachmentId ? { attachments: [{ type: "attachment" as const, attachmentId }] } : {}),
		timestamp: 1_700_000_000_000,
	};
}

function flushTurn(manager: SessionManager): string {
	return manager.appendMessage(fauxAssistantMessage("done"));
}

function decodeExportedSessionData(html: string): {
	entries: Array<SessionEntry | { type: "attachment"; attachment: AttachmentRecord }>;
} {
	const match = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
	if (!match?.[1]) throw new Error("Missing exported session data");
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

describe("Issue 5 attachment persistence", () => {
	const tempDirs: string[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function createPersistentManager(): AttachmentSessionManager {
		const cwd = mkdtempSync(join(tmpdir(), "pi-attachment-persistence-"));
		tempDirs.push(cwd);
		return withAttachmentApi(SessionManager.create(cwd, join(cwd, "sessions")));
	}

	it("writes one attachment registry entry and lightweight message references to JSONL", () => {
		const manager = createPersistentManager();
		manager.appendAttachment(attachment);
		manager.appendMessage(userMessage("Analyze", attachment.id));
		flushTurn(manager);

		const lines = readFileSync(manager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const attachmentEntry = lines.find((entry) => entry.type === "attachment");
		const messageEntry = lines.find((entry) => entry.type === "message");

		expect(attachmentEntry).toMatchObject({ type: "attachment", attachment });
		expect(messageEntry.message.attachments).toEqual([{ type: "attachment", attachmentId: attachment.id }]);
		expect(JSON.stringify(messageEntry)).not.toContain("file_openai_123");
	});

	it("persists audited remote lifecycle updates while resolving one current attachment", () => {
		const manager = createPersistentManager();
		manager.appendAttachment(attachment);
		manager.appendMessage(userMessage("Analyze", attachment.id));
		const updated: AttachmentRecord = {
			...attachment,
			remotes: {
				...attachment.remotes,
				"anthropic:anthropic-messages:https://api.anthropic.com": {
					provider: "anthropic",
					api: "anthropic-messages",
					fileId: "file_anthropic_123",
					endpoint: "https://api.anthropic.com",
					uploadedAt: 1_700_000_000_100,
					state: "ready",
				},
			},
		};
		manager.updateAttachment(updated);
		flushTurn(manager);

		expect(manager.getAttachments()).toEqual([updated]);
		const attachmentEntries = manager.getEntries().filter((entry) => entry.type === "attachment");
		expect(attachmentEntries).toHaveLength(2);
		expect(attachmentEntries[0]).not.toHaveProperty("operation");
		expect(attachmentEntries[1]).toMatchObject({ operation: "update", attachment: updated });

		const resumed = withAttachmentApi(SessionManager.open(manager.getSessionFile()!));
		expect(resumed.getAttachment(updated.id)).toEqual(updated);
		expect(resumed.getAttachments()).toEqual([updated]);
	});

	it("restores attachment metadata, missing local sources, and provider remotes on resume", () => {
		const manager = createPersistentManager();
		manager.appendAttachment(attachment);
		manager.appendMessage(userMessage("Analyze", attachment.id));
		flushTurn(manager);

		const resumed = withAttachmentApi(SessionManager.open(manager.getSessionFile()!));

		expect(resumed.getAttachment(attachment.id)).toEqual(attachment);
		expect(resumed.getAttachment(attachment.id)?.source).toEqual({
			type: "path",
			path: "/missing/paper.pdf",
		});
		expect(resumed.getAttachment(attachment.id)?.remotes?.["openai:openai-responses"]?.fileId).toBe(
			"file_openai_123",
		);
	});

	it("reconstructs the provider attachment registry when AgentSession resumes", async () => {
		const manager = createPersistentManager();
		const availableAttachment: AttachmentRecord = {
			...attachment,
			source: { type: "base64", data: "JVBERi0xLjQ=" },
		};
		const firstHarness = await createPdfHarness({ sessionManager: manager });
		harnesses.push(firstHarness);
		firstHarness.setResponses([fauxAssistantMessage("stored")]);

		await firstHarness.session.prompt("Analyze", { attachments: [availableAttachment] });
		firstHarness.cleanup();
		harnesses.splice(harnesses.indexOf(firstHarness), 1);

		const resumedManager = SessionManager.open(manager.getSessionFile()!);
		const resumedHarness = await createPdfHarness({ sessionManager: resumedManager });
		harnesses.push(resumedHarness);
		let resolved: AttachmentRecord | undefined;
		resumedHarness.setResponses([
			(context) => {
				resolved = context.attachmentRegistry?.resolve(availableAttachment.id);
				return fauxAssistantMessage("done");
			},
		]);

		await resumedHarness.session.prompt("Continue");

		expect(resolved).toEqual(availableAttachment);
	});

	it("requires fresh confirmation when a referenced local source disappears", async () => {
		const sourceDir = mkdtempSync(join(tmpdir(), "pi-attachment-source-"));
		tempDirs.push(sourceDir);
		const sourcePath = join(sourceDir, "paper.pdf");
		writeFileSync(sourcePath, "%PDF-1.4\n%%EOF\n");
		const localAttachment: AttachmentRecord = {
			id: "att_local_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "path", path: sourcePath },
		};
		const harness = await createPdfHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("stored"), fauxAssistantMessage("continued without file")]);

		await harness.session.prompt("Analyze", { attachments: [localAttachment] });
		rmSync(sourcePath);

		await expect(harness.session.prompt("Continue")).rejects.toBeInstanceOf(PortabilityConfirmationRequiredError);
		let confirmations = 0;
		await harness.session.prompt("Continue", {
			confirmPortability: (error) => {
				confirmations += 1;
				expect(error.report.items).toEqual([
					expect.objectContaining({
						attachmentId: localAttachment.id,
						classification: "missing",
					}),
				]);
				return true;
			},
		});

		expect(confirmations).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("continued without file");
	});

	it("retains required attachment entries when creating a branched session", () => {
		const manager = createPersistentManager();
		manager.appendAttachment(attachment);
		manager.appendMessage(userMessage("Analyze", attachment.id));
		const assistantId = flushTurn(manager);

		const branchFile = manager.createBranchedSession(assistantId)!;
		const branch = withAttachmentApi(SessionManager.open(branchFile));

		expect(branch.getAttachment(attachment.id)).toEqual(attachment);
		expect(branch.buildSessionContext().messages).toContainEqual(userMessage("Analyze", attachment.id));
	});

	it("does not copy attachments introduced after the selected branch point", () => {
		const manager = createPersistentManager();
		manager.appendMessage(userMessage("before attachment"));
		const branchPoint = flushTurn(manager);
		manager.appendAttachment(attachment);
		manager.appendMessage(userMessage("later", attachment.id));
		flushTurn(manager);

		const branchFile = manager.createBranchedSession(branchPoint)!;
		const branch = withAttachmentApi(SessionManager.open(branchFile));

		expect(branch.getAttachment(attachment.id)).toBeUndefined();
	});

	it("scopes attachment lookup to the active branch", () => {
		const manager = createPersistentManager();
		manager.appendMessage(userMessage("before attachment"));
		const branchPoint = flushTurn(manager);
		manager.appendAttachment(attachment);
		manager.appendMessage(userMessage("branch A", attachment.id));
		flushTurn(manager);

		manager.branch(branchPoint);

		expect(manager.getAttachment(attachment.id)).toBeUndefined();
		expect(manager.getAttachments()).toEqual([]);
	});

	it("persists the same attachment identity independently on sibling branches", () => {
		const manager = createPersistentManager();
		manager.appendMessage(userMessage("before attachment"));
		const branchPoint = flushTurn(manager);
		const branchAEntryId = manager.appendAttachment(attachment);
		manager.appendMessage(userMessage("branch A", attachment.id));
		flushTurn(manager);

		manager.branch(branchPoint);
		const branchBEntryId = manager.appendAttachment(attachment);
		manager.appendMessage(userMessage("branch B", attachment.id));
		const branchBLeaf = flushTurn(manager);

		expect(branchBEntryId).not.toBe(branchAEntryId);
		expect(manager.findDanglingAttachmentReferences()).toEqual([]);

		const branchFile = manager.createBranchedSession(branchBLeaf)!;
		const branch = withAttachmentApi(SessionManager.open(branchFile));

		expect(branch.getAttachment(attachment.id)).toEqual(attachment);
		expect(branch.findDanglingAttachmentReferences()).toEqual([]);
	});

	it("refreshes the provider attachment registry when AgentSession navigates between branches", async () => {
		const manager = createPersistentManager();
		const availableAttachment: AttachmentRecord = {
			...attachment,
			source: { type: "base64", data: "JVBERi0xLjQ=" },
		};
		manager.appendMessage(userMessage("branch point"));
		const branchPoint = flushTurn(manager);
		manager.appendAttachment(availableAttachment);
		manager.appendMessage(userMessage("branch A", availableAttachment.id));
		const branchALeaf = flushTurn(manager);

		manager.branch(branchPoint);
		manager.appendMessage(userMessage("branch B"));
		flushTurn(manager);
		const harness = await createPdfHarness({ sessionManager: manager });
		harnesses.push(harness);
		let resolved: AttachmentRecord | undefined;
		harness.setResponses([
			(context) => {
				resolved = context.attachmentRegistry?.resolve(availableAttachment.id);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.navigateTree(branchALeaf);
		await harness.session.prompt("Continue branch A");

		expect(resolved).toEqual(availableAttachment);
	});

	it("retains attachment entries when forking a persisted session", () => {
		const manager = createPersistentManager();
		manager.appendAttachment(attachment);
		manager.appendMessage(userMessage("Analyze", attachment.id));
		flushTurn(manager);
		const targetCwd = mkdtempSync(join(tmpdir(), "pi-attachment-fork-"));
		tempDirs.push(targetCwd);

		const fork = withAttachmentApi(
			SessionManager.forkFrom(manager.getSessionFile()!, targetCwd, join(targetCwd, "sessions")),
		);

		expect(fork.getAttachment(attachment.id)).toEqual(attachment);
	});

	it("preserves compacted attachment identity in a versioned manifest and summary context", () => {
		const manager = createPersistentManager();
		manager.appendAttachment(attachment);
		const introducedByMessageEntryId = manager.appendMessage(userMessage("old attachment turn", attachment.id));
		flushTurn(manager);
		const keptId = manager.appendMessage(userMessage("kept turn"));
		flushTurn(manager);
		const compactionId = manager.appendCompaction("summary", keptId, 10_000);

		expect(manager.buildContextEntries().some((entry) => (entry as { type: string }).type === "attachment")).toBe(
			false,
		);
		expect(manager.getAttachment(attachment.id)).toEqual(attachment);
		expect(manager.getEntry(compactionId)).toMatchObject({
			type: "compaction",
			attachmentManifest: {
				version: 1,
				attachments: [
					{
						attachmentId: attachment.id,
						filename: attachment.filename,
						mediaType: attachment.mediaType,
						introducedByMessageEntryId,
						required: true,
					},
				],
			},
		});
		expect(JSON.stringify(manager.buildSessionContext().messages)).toContain(
			`paper.pdf (${attachment.mediaType}, id: ${attachment.id}, introduced by: ${introducedByMessageEntryId})`,
		);
	});

	it("reports dangling message attachment references without rejecting session load", () => {
		const manager = createPersistentManager();
		manager.appendMessage(userMessage("Analyze", "att_missing"));
		flushTurn(manager);

		const resumed = withAttachmentApi(SessionManager.open(manager.getSessionFile()!));

		expect(resumed.findDanglingAttachmentReferences()).toEqual([
			{ attachmentId: "att_missing", messageEntryId: expect.any(String) },
		]);
	});

	it("includes attachment metadata but not local bytes in HTML export data", async () => {
		const manager = createPersistentManager();
		const inlineAttachment: AttachmentRecord = {
			...attachment,
			id: "att_inline",
			source: { type: "base64", data: "JVBERi0xLjQ=" },
			metadata: {
				vendorTag: "preserved",
				sourceAvailable: true,
				preparationStatus: "ready",
				nativeMethod: "stale-method",
				unsupportedReason: "stale-reason",
			},
		};
		manager.appendAttachment(inlineAttachment);
		manager.appendMessage(userMessage("Analyze", inlineAttachment.id));
		flushTurn(manager);

		const outputPath = await exportFromFile(manager.getSessionFile()!, {
			outputPath: join(dirname(manager.getSessionFile()!), "attachment-export.html"),
		});
		const html = readFileSync(outputPath, "utf8");
		const sessionData = decodeExportedSessionData(html);
		const exportedAttachment = sessionData.entries.find((entry) => entry.type === "attachment");

		expect(exportedAttachment).toMatchObject({
			type: "attachment",
			attachment: {
				id: inlineAttachment.id,
				filename: inlineAttachment.filename,
				mediaType: inlineAttachment.mediaType,
				metadata: { vendorTag: "preserved" },
				source: { type: "base64", data: "[omitted from export]" },
			},
			attachmentRuntimeState: {
				source: { status: "redacted", reason: "Inline data is omitted." },
				transport: { status: "unresolved" },
			},
		});
		expect(html).toContain("attachment-entry");
		expect(html).not.toContain("JVBERi0xLjQ=");
	});

	it("redacts inline attachment bytes from JSONL exports by default", async () => {
		const manager = createPersistentManager();
		const inlineAttachment: AttachmentRecord = {
			...attachment,
			id: "att_json_inline",
			source: { type: "base64", data: "JVBERi0xLjQ=SECRET" },
			metadata: { vendorTag: "preserved", preparationStatus: "ready", sourceAvailable: true },
		};
		manager.appendAttachment(inlineAttachment);
		manager.appendMessage(userMessage("Analyze", inlineAttachment.id));
		flushTurn(manager);
		const harness = await createPdfHarness({ sessionManager: manager });
		harnesses.push(harness);
		const outputPath = join(manager.getCwd(), "safe-export.jsonl");

		harness.session.exportToJsonl(outputPath);
		const exported = readFileSync(outputPath, "utf8");

		expect(exported).toContain("[omitted from export]");
		expect(exported).not.toContain("JVBERi0xLjQ=SECRET");
		expect(exported).toContain('"vendorTag":"preserved"');
		expect(exported).not.toContain("preparationStatus");
		expect(exported).not.toContain("sourceAvailable");
		expect(exported).not.toContain("attachmentRuntimeState");
	});

	it("redacts signed remote URLs from JSONL exports", async () => {
		const manager = createPersistentManager();
		const remoteAttachment: AttachmentRecord = {
			...attachment,
			id: "att_signed_url",
			source: {
				type: "url",
				url: "https://files.example.com/paper.pdf?X-Amz-Signature=secret&download=1",
			},
			remotes: {
				openai: {
					provider: "openai",
					api: "openai-responses",
					fileId: "file_123",
					uri: "https://files.example.com/file_123?token=remote-secret",
					uploadedAt: 1,
				},
			},
		};
		manager.appendAttachment(remoteAttachment);
		manager.appendMessage(userMessage("Analyze", remoteAttachment.id));
		flushTurn(manager);
		const harness = await createPdfHarness({ sessionManager: manager });
		harnesses.push(harness);
		const outputPath = join(manager.getCwd(), "safe-remote-export.jsonl");

		harness.session.exportToJsonl(outputPath);
		const exported = readFileSync(outputPath, "utf8");
		expect(exported).toContain("redacted=true");
		expect(exported).not.toContain("secret");
	});

	it("round-trips provider-native conversation state through session persistence", () => {
		const manager = createPersistentManager();
		const message = {
			...fauxAssistantMessage("native answer"),
			content: [
				{
					type: "toolCall" as const,
					id: "call_1",
					name: "web_search",
					arguments: { query: "Pi" },
					providerMetadata: { serverToolUseId: "srv_1" },
				},
			],
			nativeParts: [
				{
					type: "provider-native" as const,
					provider: "faux",
					api: "openai-completions" as const,
					kind: "server-tool-state",
					payload: { id: "srv_1" },
				},
			],
			citations: [{ type: "citation" as const, title: "Reference", url: "https://example.com/ref" }],
			reasoningState: [{ provider: "faux", encrypted: "opaque", signature: "signature" }],
			providerState: { provider: "faux", responseId: "response_1" },
		};
		manager.appendMessage(message);

		const resumed = SessionManager.open(manager.getSessionFile()!);
		const restored = resumed.getEntries().find((entry) => entry.type === "message");
		expect(restored).toMatchObject({
			type: "message",
			message: JSON.parse(JSON.stringify(message)),
		});
	});

	it("redacts provider-native secrets only at the export boundary", async () => {
		const manager = createPersistentManager();
		manager.appendMessage({
			...fauxAssistantMessage("native answer"),
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "computer",
					arguments: {},
					providerMetadata: { access_token: "tool-secret" },
				},
			],
			nativeParts: [
				{
					type: "provider-native",
					provider: "faux",
					kind: "state",
					payload: { api_key: "native-secret", data: "UERG" },
				},
			],
			citations: [
				{
					type: "citation",
					url: "https://example.com/ref?signature=citation-secret",
					raw: { authorization: "citation-token" },
				},
			],
			reasoningState: [
				{
					provider: "faux",
					encrypted: "reasoning-secret",
					signature: "reasoning-signature",
					metadata: { token: "metadata-secret" },
				},
			],
			providerState: { provider: "faux", metadata: { password: "state-secret" } },
		});
		const harness = await createPdfHarness({ sessionManager: manager });
		harnesses.push(harness);
		const outputPath = join(manager.getCwd(), "safe-native-export.jsonl");

		harness.session.exportToJsonl(outputPath);
		const persisted = readFileSync(manager.getSessionFile()!, "utf8");
		const exported = readFileSync(outputPath, "utf8");

		expect(persisted).toContain("reasoning-secret");
		expect(exported).not.toContain("native-secret");
		expect(exported).not.toContain("tool-secret");
		expect(exported).not.toContain("citation-secret");
		expect(exported).not.toContain("reasoning-secret");
		expect(exported).not.toContain("state-secret");
		expect(exported).toContain("[redacted]");
	});

	it("stores inline attachment bytes once even when multiple messages reference them", () => {
		const manager = createPersistentManager();
		const inlineAttachment: AttachmentRecord = {
			...attachment,
			id: "att_deduplicated",
			source: { type: "base64", data: "JVBERi0xLjQ=" },
		};
		manager.appendAttachment(inlineAttachment);
		manager.appendMessage(userMessage("first", inlineAttachment.id));
		flushTurn(manager);
		manager.appendMessage(userMessage("second", inlineAttachment.id));
		flushTurn(manager);

		const jsonl = readFileSync(manager.getSessionFile()!, "utf8");

		expect(jsonl.match(/JVBERi0xLjQ=/g)).toHaveLength(1);
	});

	it("does not add attachment entries or fields to legacy sessions", () => {
		const manager = createPersistentManager();
		manager.appendMessage(userMessage("hello"));
		flushTurn(manager);

		const lines = readFileSync(manager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(lines.some((entry) => entry.type === "attachment")).toBe(false);
		expect(lines.find((entry) => entry.type === "message")?.message).toEqual(userMessage("hello"));
	});
});
