import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type AttachmentRecord, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const attachment: AttachmentRecord = {
	id: "att_tool_pdf",
	filename: "report.pdf",
	mediaType: "application/pdf",
	sizeBytes: 8,
	source: { type: "base64", data: "JVBERi0x" },
};

describe("Issue 12 tool-result attachment contracts", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("registers, persists, exposes, and forwards final tool attachments exactly once", async () => {
		const extensionAttachments: AttachmentRecord[][] = [];
		const tool: AgentTool = {
			name: "make_report",
			label: "Make report",
			description: "Create a PDF report",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text", text: "created" }],
					details: {},
					attachments: [attachment],
				};
			},
		};
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", (event) => {
						extensionAttachments.push(event.attachments ?? []);
						return { content: [{ type: "text", text: "hooked" }] };
					});
				},
			],
		});
		harnesses.push(harness);
		let nextProviderMessages: readonly AgentMessage[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("make_report", {}), { stopReason: "toolUse" }),
			(context) => {
				nextProviderMessages = context.messages;
				expect(context.attachmentRegistry?.resolve(attachment.id)).toEqual(attachment);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("create report");

		const toolResult = nextProviderMessages.find((message) => message.role === "toolResult");
		expect(toolResult).toMatchObject({
			content: [{ type: "text", text: "hooked" }],
			attachments: [{ type: "attachment", attachmentId: attachment.id }],
		});
		expect(extensionAttachments).toEqual([[attachment]]);
		expect(harness.sessionManager.getAttachments()).toEqual([attachment]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "attachment")).toHaveLength(1);
		expect(harness.sessionManager.findDanglingAttachmentReferences()).toEqual([]);

		const end = harness.eventsOfType("tool_execution_end")[0];
		expect(end?.result.attachments).toEqual([attachment]);
		expect(JSON.parse(JSON.stringify(end))).toMatchObject({ result: { attachments: [attachment] } });
	});
});
