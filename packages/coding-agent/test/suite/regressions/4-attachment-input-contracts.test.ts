import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("allows provider lowering to read the exact bytes of a local attachment", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-attachment-registry-"));
		const filePath = join(directory, "paper.pdf");
		const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]);
		writeFileSync(filePath, bytes);
		const localAttachment: AttachmentRecord = {
			...attachment,
			source: { type: "path", path: filePath },
		};
		const harness = await createHarness();
		harnesses.push(harness);
		let providerBytes: Uint8Array | undefined;
		harness.setResponses([
			(context) => {
				const resolved = context.attachmentRegistry?.resolve(localAttachment.id);
				if (resolved) providerBytes = context.attachmentRegistry?.read?.(resolved);
				return fauxAssistantMessage("done");
			},
		]);

		try {
			await harness.session.prompt("Analyze this", { attachments: [localAttachment] });
			expect(providerBytes).toEqual(bytes);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
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

	it("accepts an already-uploaded provider file as an additive SDK input", async () => {
		const providerFile: AttachmentRecord = {
			...attachment,
			id: "att_remote",
			source: { type: "provider-file", provider: "openai", fileId: "file_123" },
		};
		const harness = await createHarness();
		harnesses.push(harness);
		let resolvedAttachment: AttachmentRecord | undefined;
		harness.setResponses([
			(context) => {
				resolvedAttachment = context.attachmentRegistry?.resolve(providerFile.id);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("Reuse this", { attachments: [providerFile] });

		expect(resolvedAttachment).toEqual(providerFile);
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

	it("opts into a confirmed lossy RPC prompt without changing the legacy overload", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];
		(client as unknown as { send(command: unknown): Promise<void> }).send = async (command) => {
			sent.push(command);
		};

		await client.prompt("Continue without video", undefined, [attachment], { allowLossy: true });

		expect(sent).toEqual([
			{
				type: "prompt",
				message: "Continue without video",
				images: undefined,
				attachments: [attachment],
				allowLossy: true,
			},
		]);
	});

	it("exposes the applied portability projection over RPC", async () => {
		const client = new RpcClient();
		const sent: unknown[] = [];
		(client as unknown as { send(command: unknown): Promise<unknown> }).send = async (command) => {
			sent.push(command);
			return {
				type: "response",
				command: "get_portability_projection",
				success: true,
				data: { suspendedAttachmentIds: [attachment.id] },
			};
		};

		const projection = await client.getPortabilityProjection("faux", "faux-2");

		expect(sent).toEqual([{ type: "get_portability_projection", provider: "faux", modelId: "faux-2" }]);
		expect(projection).toMatchObject({ suspendedAttachmentIds: [attachment.id] });
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
