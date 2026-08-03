import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AttachmentRecord, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { exportFromFile } from "../../../src/core/export-html/index.ts";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

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
		const firstHarness = await createHarness({ sessionManager: manager });
		harnesses.push(firstHarness);
		firstHarness.setResponses([fauxAssistantMessage("stored")]);

		await firstHarness.session.prompt("Analyze", { attachments: [attachment] });
		firstHarness.cleanup();
		harnesses.splice(harnesses.indexOf(firstHarness), 1);

		const resumedManager = SessionManager.open(manager.getSessionFile()!);
		const resumedHarness = await createHarness({ sessionManager: resumedManager });
		harnesses.push(resumedHarness);
		let resolved: AttachmentRecord | undefined;
		resumedHarness.setResponses([
			(context) => {
				resolved = context.attachmentRegistry?.resolve(attachment.id);
				return fauxAssistantMessage("done");
			},
		]);

		await resumedHarness.session.prompt("Continue");

		expect(resolved).toEqual(attachment);
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

	it("keeps the attachment registry authoritative after compaction omits old message entries", () => {
		const manager = createPersistentManager();
		manager.appendAttachment(attachment);
		manager.appendMessage(userMessage("old attachment turn", attachment.id));
		flushTurn(manager);
		const keptId = manager.appendMessage(userMessage("kept turn"));
		flushTurn(manager);
		manager.appendCompaction("summary mentioning paper.pdf", keptId, 10_000);

		expect(manager.buildContextEntries().some((entry) => (entry as { type: string }).type === "attachment")).toBe(
			false,
		);
		expect(manager.getAttachment(attachment.id)).toEqual(attachment);
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
		};
		manager.appendAttachment(inlineAttachment);
		manager.appendMessage(userMessage("Analyze", inlineAttachment.id));
		flushTurn(manager);

		const outputPath = await exportFromFile(manager.getSessionFile()!);
		const html = readFileSync(outputPath, "utf8");
		const sessionData = decodeExportedSessionData(html);
		const exportedAttachment = sessionData.entries.find((entry) => entry.type === "attachment");

		expect(exportedAttachment).toMatchObject({
			type: "attachment",
			attachment: {
				id: inlineAttachment.id,
				filename: inlineAttachment.filename,
				mediaType: inlineAttachment.mediaType,
				source: { type: "base64", data: "[omitted from HTML export]" },
			},
		});
		expect(html).toContain("attachment-entry");
		expect(html).not.toContain("JVBERi0xLjQ=");
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
