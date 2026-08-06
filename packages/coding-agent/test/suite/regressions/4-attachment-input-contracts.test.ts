import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AttachmentRecord,
	type AttachmentReference,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { createHarness, type Harness } from "../harness.ts";

const attachment: AttachmentRecord = {
	id: "att_pdf",
	filename: "paper.pdf",
	mediaType: "application/pdf",
	sizeBytes: 12,
	source: { type: "path", path: "/tmp/paper.pdf" },
};

const reference: AttachmentReference = {
	type: "attachment",
	attachmentId: attachment.id,
};

const secondAttachment: AttachmentRecord = {
	id: "att_notes",
	filename: "notes.pdf",
	mediaType: "application/pdf",
	source: { type: "base64", data: "JVBERi0xLjQ=" },
};

function findUserMessage(messages: readonly AgentMessage[]) {
	return messages.find((message) => message.role === "user");
}

async function createWaitingHarness(): Promise<{
	harness: Harness;
	releaseToolExecution: () => void;
	waitForToolStart: Promise<void>;
	promptPromise: Promise<void>;
}> {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for queued attachment input",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [waitTool] });
	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	return {
		harness,
		releaseToolExecution: () => releaseToolExecution?.(),
		waitForToolStart,
		promptPromise: harness.session.prompt("start"),
	};
}

describe("Issue 4 attachment input contracts", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("adds attachment references to the SDK prompt user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerMessages: readonly AgentMessage[] = [];
		harness.setResponses([
			(context) => {
				providerMessages = context.messages;
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("Analyze this", { attachments: [attachment] });

		const userMessage = findUserMessage(providerMessages);
		expect(userMessage).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Analyze this" }],
			attachments: [reference],
		});
	});

	it("makes SDK prompt attachment records resolvable by the provider context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let resolvedAttachment: AttachmentRecord | undefined;
		harness.setResponses([
			(context) => {
				resolvedAttachment = context.attachmentRegistry?.resolve(attachment.id);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("Analyze this", { attachments: [attachment] });

		expect(resolvedAttachment).toEqual(attachment);
	});

	it("supports object-style SDK prompts with multiple ordered attachments", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerUser: AgentMessage | undefined;
		harness.setResponses([
			(context) => {
				providerUser = findUserMessage(context.messages);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt({ text: "Compare", attachments: [attachment, secondAttachment] });

		expect(providerUser).toMatchObject({
			attachments: [reference, { type: "attachment", attachmentId: secondAttachment.id }],
		});
	});

	it("exposes attachment references on the input event", async () => {
		let inputAttachments: readonly AttachmentReference[] | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						inputAttachments = event.attachments;
						return { action: "continue" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("Analyze this", { attachments: [attachment] });

		expect(inputAttachments).toEqual([reference]);
	});

	it("preserves attachments when an input extension transforms only text", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => ({
						action: "transform",
						text: `transformed:${event.text}`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerUser: AgentMessage | undefined;
		harness.setResponses([
			(context) => {
				providerUser = findUserMessage(context.messages);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("Analyze this", { attachments: [attachment] });

		expect(providerUser).toMatchObject({
			content: [{ type: "text", text: "transformed:Analyze this" }],
			attachments: [reference],
		});
	});

	it("allows an input transform to explicitly remove attachments", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => ({ action: "transform", text: event.text, attachments: [] }));
				},
			],
		});
		harnesses.push(harness);
		let providerUser: AgentMessage | undefined;
		harness.setResponses([
			(context) => {
				providerUser = findUserMessage(context.messages);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("Analyze this", { attachments: [attachment] });

		expect(providerUser).not.toHaveProperty("attachments");
	});

	it("rejects attachment IDs introduced by an input transform without a registry record", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => ({
						action: "transform",
						text: event.text,
						attachments: [{ type: "attachment", attachmentId: "missing" }],
					}));
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.prompt("Analyze this", { attachments: [attachment] })).rejects.toThrow(
			"Unknown attachment ID: missing",
		);
	});

	it("exposes attachment references on before_agent_start", async () => {
		let beforeStartAttachments: readonly AttachmentReference[] | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						beforeStartAttachments = event.attachments;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("Analyze this", { attachments: [attachment] });

		expect(beforeStartAttachments).toEqual([reference]);
	});

	it("lets extensions submit attachment-aware messages", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		harnesses.push(harness);
		let providerUser: AgentMessage | undefined;
		harness.setResponses([
			(context) => {
				providerUser = findUserMessage(context.messages);
				return fauxAssistantMessage("done");
			},
		]);

		extensionApi?.sendUserMessage("Analyze this", { attachments: [attachment] });
		await vi.waitFor(() => expect(providerUser).toBeDefined());
		await harness.session.agent.waitForIdle();

		expect(providerUser).toMatchObject({ attachments: [reference] });
	});

	it("serializes attachments on RPC prompt commands", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];
		(client as unknown as { send(command: unknown): Promise<void> }).send = async (command) => {
			sent.push(command);
		};

		await client.prompt("Analyze this", undefined, [attachment]);

		expect(sent).toEqual([{ type: "prompt", message: "Analyze this", images: undefined, attachments: [attachment] }]);
	});

	it("serializes attachments on RPC steering and follow-up commands", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];
		(client as unknown as { send(command: unknown): Promise<void> }).send = async (command) => {
			sent.push(command);
		};

		await client.steer("Steer", undefined, [attachment]);
		await client.followUp("Follow", undefined, [secondAttachment]);

		expect(sent).toEqual([
			{ type: "steer", message: "Steer", images: undefined, attachments: [attachment] },
			{ type: "follow_up", message: "Follow", images: undefined, attachments: [secondAttachment] },
		]);
	});

	it("keeps the attachment-free RPC wire payload unchanged", async () => {
		const client = new RpcClient();
		let serialized = "";
		(client as unknown as { send(command: unknown): Promise<void> }).send = async (command) => {
			serialized = JSON.stringify(command);
		};

		await client.prompt("hello");

		expect(serialized).toBe('{"type":"prompt","message":"hello"}');
	});

	it("preserves attachments in a steering queue through the next provider call", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, releaseToolExecution, promptPromise } = waiting;
		harnesses.push(harness);
		let queuedUser: AgentMessage | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				queuedUser = [...context.messages].reverse().find((message) => message.role === "user");
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.steer("steer with PDF", undefined, [attachment]);
		releaseToolExecution();
		await promptPromise;

		expect(queuedUser).toMatchObject({ attachments: [reference] });
	});

	it("preserves attachments in a follow-up queue through the next provider call", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, releaseToolExecution, promptPromise } = waiting;
		harnesses.push(harness);
		let queuedUser: AgentMessage | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("initial turn done"),
			(context) => {
				queuedUser = [...context.messages].reverse().find((message) => message.role === "user");
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("follow up with PDF", undefined, [attachment]);
		releaseToolExecution();
		await promptPromise;

		expect(queuedUser).toMatchObject({ attachments: [reference] });
	});

	it("rejects malformed attachment sources before the provider call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const malformed = {
			...attachment,
			source: { type: "path" },
		} as unknown as AttachmentRecord;

		await expect(harness.session.prompt("Analyze", { attachments: [malformed] })).rejects.toThrow(
			"unsupported or malformed source",
		);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not add attachment fields to legacy prompts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerUser: AgentMessage | undefined;
		let hasRegistry = false;
		harness.setResponses([
			(context) => {
				providerUser = findUserMessage(context.messages);
				hasRegistry = context.attachmentRegistry !== undefined;
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(providerUser).toEqual({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: expect.any(Number),
		});
		expect(hasRegistry).toBe(false);
	});
});
