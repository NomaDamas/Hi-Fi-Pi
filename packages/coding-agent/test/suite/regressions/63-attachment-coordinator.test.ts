import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AttachmentRecord, type AttachmentRegistry, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const attachment: AttachmentRecord = {
	id: "att_contract",
	filename: "contract.pdf",
	mediaType: "application/pdf",
	source: { type: "base64", data: "JVBERi0xLjQ=" },
};

describe("Issue 63 attachment coordinator contracts", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("rejects conflicting records without replacing the registered attachment", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("stored")]);

		await harness.session.prompt("store", { attachments: [attachment] });
		const conflict: AttachmentRecord = { ...attachment, filename: "different.pdf" };

		await expect(harness.session.prompt("replace", { attachments: [conflict] })).rejects.toThrow(
			'Attachment ID "att_contract" is already registered with different metadata.',
		);
		expect(harness.sessionManager.getAttachment(attachment.id)).toEqual(attachment);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "attachment")).toHaveLength(1);
	});

	it("validates attachment records before binding or persisting the registry", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const invalidAttachment = {
			...attachment,
			source: { type: "path", path: "" },
		} as AttachmentRecord;

		await expect(harness.session.prompt("invalid", { attachments: [invalidAttachment] })).rejects.toThrow(
			'Invalid attachment "att_contract": unsupported or malformed source.',
		);
		expect(harness.session.agent.attachmentRegistry).toBeUndefined();
		expect(harness.sessionManager.getAttachments()).toEqual([]);
	});

	it("persists registry updates and exposes the updated record to the next provider turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let registry: AttachmentRegistry | undefined;
		let resolvedOnNextTurn: AttachmentRecord | undefined;
		harness.setResponses([
			(context) => {
				registry = context.attachmentRegistry;
				return fauxAssistantMessage("stored");
			},
			(context) => {
				resolvedOnNextTurn = context.attachmentRegistry?.resolve(attachment.id);
				return fauxAssistantMessage("updated");
			},
		]);

		await harness.session.prompt("store", { attachments: [attachment] });
		const updated: AttachmentRecord = {
			...attachment,
			remotes: {
				"openai:openai-responses": {
					provider: "openai",
					api: "openai-responses",
					fileId: "file_123",
					uploadedAt: 1_700_000_000_000,
				},
			},
		};
		await registry?.update?.(updated);
		await harness.session.prompt("continue");

		expect(harness.sessionManager.getAttachment(attachment.id)).toEqual(updated);
		expect(resolvedOnNextTurn).toEqual(updated);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "attachment")).toHaveLength(2);
	});

	it("rejects registry updates for unknown attachment identities", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let registry: AttachmentRegistry | undefined;
		harness.setResponses([
			(context) => {
				registry = context.attachmentRegistry;
				return fauxAssistantMessage("stored");
			},
		]);

		await harness.session.prompt("store", { attachments: [attachment] });
		const unknown: AttachmentRecord = { ...attachment, id: "att_unknown" };

		expect(() => registry?.update?.(unknown)).toThrow('Cannot update unknown attachment ID "att_unknown".');
		expect(harness.sessionManager.getAttachment(unknown.id)).toBeUndefined();
	});

	it("keeps ordered lightweight references in the public user-message contract", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const second: AttachmentRecord = { ...attachment, id: "att_second", filename: "second.pdf" };
		let userMessage: AgentMessage | undefined;
		harness.setResponses([
			(context) => {
				userMessage = context.messages.find((message) => message.role === "user");
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("compare", { attachments: [attachment, second] });

		expect(userMessage).toMatchObject({
			attachments: [
				{ type: "attachment", attachmentId: attachment.id },
				{ type: "attachment", attachmentId: second.id },
			],
		});
	});

	it("delegates portability source availability to the coordinator", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "hifi-attachment-coordinator-"));
		const sourcePath = join(testDir, "paper.pdf");
		writeFileSync(sourcePath, "%PDF-1.7\n");
		const localAttachment: AttachmentRecord = {
			...attachment,
			id: "att_local",
			source: { type: "path", path: sourcePath },
		};
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("stored")]);

		try {
			await harness.session.prompt("store", { attachments: [localAttachment] });
			const available = harness.session.getPortabilityReport(harness.session.model!);
			expect(
				available.items.some(
					(item) => item.attachmentId === localAttachment.id && item.classification === "missing",
				),
			).toBe(false);

			rmSync(sourcePath);
			const missing = harness.session.getPortabilityReport(harness.session.model!);
			expect(missing.items).toContainEqual(
				expect.objectContaining({ attachmentId: localAttachment.id, classification: "missing" }),
			);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
