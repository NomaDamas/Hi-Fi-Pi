import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AttachmentRecord, Context, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, PortabilityConfirmationRequiredError } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	PortabilityProjectionCoordinator,
	PortabilityProjectionUnavailableError,
} from "../../../src/core/attachments/portability-projection.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MP4 = "video/mp4";

function attachment(id: string, filename: string, mediaType: string): AttachmentRecord {
	return {
		id,
		filename,
		mediaType,
		source: { type: "base64", data: Buffer.from(`${id}-bytes`).toString("base64") },
	};
}

function allowInline(model: Model<string>, mediaTypes: string[]): void {
	const nativeInputs: NonNullable<Model<string>["nativeInputs"]> = {
		profile: `${model.id}-test-files`,
		capabilities: [
			{
				id: "test-files",
				supported: true,
				mediaTypes,
				sources: ["inline"],
				wireKinds: { inline: "test-file" },
				provenance: "configured",
			},
		],
	};
	model.nativeInputs = nativeInputs;
}

function attachmentIds(messages: readonly unknown[]): string[] {
	return messages.flatMap((message) => {
		if (!message || typeof message !== "object" || !("attachments" in message)) return [];
		const attachments = (message as { attachments?: unknown }).attachments;
		if (!Array.isArray(attachments)) return [];
		return attachments.flatMap((item) =>
			item && typeof item === "object" && "attachmentId" in item && typeof item.attachmentId === "string"
				? [item.attachmentId]
				: [],
		);
	});
}

describe("issue #76 portability projection", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	it("projects confirmed incompatible attachments without mutating canonical history", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
		});
		harnesses.push(harness);
		const source = harness.getModel("faux-1")!;
		const target = harness.getModel("faux-2")!;
		allowInline(source, [XLSX, MP4]);
		allowInline(target, [XLSX]);

		const spreadsheet = attachment("att_xlsx", "results.xlsx", XLSX);
		const video = attachment("att_mp4", "demo.mp4", MP4);
		const observedContexts: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage("source saw files"),
			(context) => {
				observedContexts.push(attachmentIds(context.messages));
				return fauxAssistantMessage("target response");
			},
			(context) => {
				observedContexts.push(attachmentIds(context.messages));
				return fauxAssistantMessage("source response");
			},
			(context) => {
				observedContexts.push(attachmentIds(context.messages));
				return fauxAssistantMessage("target response again");
			},
		]);

		await harness.session.prompt({ text: "inspect both", attachments: [spreadsheet, video] });
		await expect(harness.session.setModel(target)).rejects.toBeInstanceOf(PortabilityConfirmationRequiredError);
		await harness.session.setModel(target, { allowLossy: true });
		expect(harness.eventsOfType("portability_projection").at(-1)?.projection).toMatchObject({
			target: { modelId: "faux-2" },
			suspendedAttachmentIds: ["att_mp4"],
			unapprovedItemIds: [],
		});
		expect(harness.session.getLatestProviderTrace()).toMatchObject({
			stage: "context_projection",
			provider: target.provider,
			modelId: target.id,
			payload: {
				activeItemIds: ["attachment:att_xlsx"],
				suspendedItemIds: ["attachment:att_mp4"],
				unapprovedItemIds: [],
			},
		});
		await harness.session.prompt("continue on target");

		expect(observedContexts[0]).toContain("att_xlsx");
		expect(observedContexts[0]).not.toContain("att_mp4");
		expect(attachmentIds(harness.session.messages)).toEqual(["att_xlsx", "att_mp4"]);
		expect(harness.session.getPortabilityProjection()).toMatchObject({
			target: { modelId: "faux-2" },
			activeAttachmentIds: ["att_xlsx"],
			suspendedAttachmentIds: ["att_mp4"],
			unapprovedItemIds: [],
		});

		await harness.session.setModel(source);
		await harness.session.prompt("continue on source");
		expect(observedContexts[1]).toEqual(expect.arrayContaining(["att_xlsx", "att_mp4"]));
		expect(harness.session.getPortabilityProjection().suspendedAttachmentIds).toEqual([]);

		await harness.session.setModel(target);
		await harness.session.prompt("reuse exact target decision");
		expect(observedContexts[2]).toContain("att_xlsx");
		expect(observedContexts[2]).not.toContain("att_mp4");

		const otherEndpoint = { ...target, baseUrl: "https://other.example/v1" };
		await expect(harness.session.setModel(otherEndpoint)).rejects.toBeInstanceOf(
			PortabilityConfirmationRequiredError,
		);
	});

	it("does not let a later attachment inherit stale omission consent", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
		});
		harnesses.push(harness);
		const source = harness.getModel("faux-1")!;
		const target = harness.getModel("faux-2")!;
		allowInline(source, [MP4]);
		allowInline(target, []);

		harness.setResponses([
			fauxAssistantMessage("seeded"),
			(context) => {
				expect(attachmentIds(context.messages)).toEqual([]);
				return fauxAssistantMessage("confirmed second omission");
			},
		]);
		await harness.session.prompt({ text: "first", attachments: [attachment("att_old", "old.mp4", MP4)] });
		await harness.session.setModel(target, { allowLossy: true });

		const newVideo = attachment("att_new", "new.mp4", MP4);
		await expect(harness.session.prompt({ text: "new file", attachments: [newVideo] })).rejects.toBeInstanceOf(
			PortabilityConfirmationRequiredError,
		);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getAttachments().map((record) => record.id)).not.toContain(newVideo.id);
		expect(harness.session.agent.attachmentRegistry?.resolve(newVideo.id)).toBeUndefined();

		await harness.session.prompt({ text: "new file", attachments: [newVideo] }, { allowLossy: true });
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(attachmentIds(harness.session.messages)).toEqual(["att_old", "att_new"]);
	});

	it("preflights direct steer and follow-up inputs before queue mutation", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
		});
		harnesses.push(harness);
		const source = harness.getModel("faux-1")!;
		const target = harness.getModel("faux-2")!;
		allowInline(source, [MP4]);
		allowInline(target, []);
		harness.setResponses([fauxAssistantMessage("seeded")]);
		await harness.session.prompt({ text: "seed", attachments: [attachment("att_old", "old.mp4", MP4)] });
		await harness.session.setModel(target, { allowLossy: true });

		const steeredVideo = attachment("att_steer", "steer.mp4", MP4);
		await expect(harness.session.steer("steer", undefined, [steeredVideo])).rejects.toBeInstanceOf(
			PortabilityConfirmationRequiredError,
		);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.agent.attachmentRegistry?.resolve(steeredVideo.id)).toBeUndefined();

		await harness.session.steer("steer", undefined, [steeredVideo], { allowLossy: true });
		expect(harness.session.pendingMessageCount).toBe(1);

		const followUpVideo = attachment("att_follow_up", "follow-up.mp4", MP4);
		let confirmations = 0;
		await harness.session.followUp("follow", undefined, [followUpVideo], {
			confirmPortability: () => {
				confirmations += 1;
				return true;
			},
		});
		expect(confirmations).toBe(1);
		expect(harness.session.pendingMessageCount).toBe(2);
		expect(harness.sessionManager.getAttachments().map((record) => record.id)).toEqual(
			expect.arrayContaining([steeredVideo.id, followUpVideo.id]),
		);
	});

	it("persists a tool-result suspension decision across session resume", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "hifi-portability-resume-"));
		tempDirs.push(sessionDir);
		const manager = SessionManager.create(sessionDir, sessionDir);
		const video = attachment("att_tool_video", "tool-output.mp4", MP4);
		manager.appendAttachment(video);
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_video",
			toolName: "render_video",
			content: [{ type: "text", text: "Rendered video" }],
			attachments: [{ type: "attachment", attachmentId: video.id }],
			isError: false,
			timestamp: Date.now(),
		};
		manager.appendMessage(toolResult);
		manager.appendMessage(fauxAssistantMessage("Tool output received"));

		const first = await createHarness({
			sessionManager: manager,
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
		});
		harnesses.push(first);
		const target = first.getModel("faux-2")!;
		allowInline(first.getModel("faux-1")!, [MP4]);
		allowInline(target, []);
		first.session.agent.state.messages = manager.buildSessionContext().messages;
		await first.session.setModel(target, { allowLossy: true });
		expect(first.session.getPortabilityProjection().suspendedAttachmentIds).toEqual([video.id]);

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("persistent session file was not created");
		first.cleanup();
		harnesses.pop();

		const reopened = SessionManager.open(sessionFile, sessionDir);
		const decisions = reopened
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "hifi.portability-decision");
		expect(decisions).toHaveLength(1);
		const resumed = new PortabilityProjectionCoordinator({
			store: reopened,
			listAttachments: () => reopened.getAttachments(),
			sourceAvailable: () => true,
		});
		expect(reopened.getAttachments().map((record) => record.id)).toEqual([video.id]);
		const resumedMessages = reopened
			.buildSessionContext()
			.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
		expect(attachmentIds(resumedMessages)).toEqual([video.id]);

		expect(resumed.inspect(resumedMessages, target)).toMatchObject({
			suspendedAttachmentIds: [video.id],
			unapprovedItemIds: [],
		});
	});

	it("uses the accepted projection for compaction materialization", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
		});
		harnesses.push(harness);
		const source = harness.getModel("faux-1")!;
		const target = harness.getModel("faux-2")!;
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old native context" }],
			nativeParts: [
				{
					type: "provider-native",
					provider: source.provider,
					api: source.api,
					modelId: source.id,
					kind: "video-state",
					stateId: "video_state_1",
					payload: { opaque: true },
				},
			],
			timestamp: now - 3_000,
		});
		const oldAssistant = fauxAssistantMessage("old answer", { timestamp: now - 2_000 });
		oldAssistant.usage = { ...oldAssistant.usage, input: 100, totalTokens: 100 };
		harness.sessionManager.appendMessage(oldAssistant);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "recent context" }],
			timestamp: now - 1_000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("recent answer", { timestamp: now - 500 }));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await harness.session.setModel(target, { allowLossy: true });
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "new unapproved native context" }],
			nativeParts: [
				{
					type: "provider-native",
					provider: source.provider,
					api: source.api,
					modelId: source.id,
					kind: "new-video-state",
					stateId: "video_state_2",
					payload: { opaque: true },
				},
			],
			timestamp: now,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const summarizationPrompts: string[] = [];
		const captureSummary = (context: Context) => {
			const message = context.messages[0];
			if (message?.role === "user") {
				const content = message.content as string | Array<{ text?: string }>;
				summarizationPrompts.push(typeof content === "string" ? content : (content[0]?.text ?? ""));
			}
			return fauxAssistantMessage("compacted");
		};
		harness.setResponses([captureSummary, captureSummary]);

		await harness.session.compact();
		expect(summarizationPrompts.join("\n")).toContain("old native context");
		expect(summarizationPrompts.join("\n")).not.toContain("[Provider-native state]: faux/video-state");
	});

	it("uses the accepted projection for automatic compaction without creating new consent", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
		});
		harnesses.push(harness);
		const source = harness.getModel("faux-1")!;
		const target = harness.getModel("faux-2")!;
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old native context" }],
			nativeParts: [
				{
					type: "provider-native",
					provider: source.provider,
					api: source.api,
					modelId: source.id,
					kind: "video-state",
					stateId: "auto_video_state_1",
					payload: { opaque: true },
				},
			],
			timestamp: now - 3_000,
		});
		const oldAssistant = fauxAssistantMessage("old answer", { timestamp: now - 2_000 });
		oldAssistant.usage = { ...oldAssistant.usage, input: 100, totalTokens: 100 };
		harness.sessionManager.appendMessage(oldAssistant);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "recent context" }],
			timestamp: now - 1_000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("recent answer", { timestamp: now - 500 }));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await harness.session.setModel(target, { allowLossy: true });

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "new unapproved native context" }],
			nativeParts: [
				{
					type: "provider-native",
					provider: source.provider,
					api: source.api,
					modelId: source.id,
					kind: "new-video-state",
					stateId: "auto_video_state_2",
					payload: { opaque: true },
				},
			],
			timestamp: now,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("auto compacted")]);

		const internals = harness.session as unknown as {
			_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
		};
		await expect(internals._runAutoCompaction("threshold", false)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
		});
	});

	it("pauses a mid-turn tool attachment and resumes only after explicit confirmation", async () => {
		const toolVideo = attachment("att_tool_new", "generated.mp4", MP4);
		const tool: AgentTool = {
			name: "make_video",
			label: "Make video",
			description: "Create a video",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "created" }],
				details: {},
				attachments: [toolVideo],
			}),
		};
		const harness = await createHarness({
			tools: [tool],
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
		});
		harnesses.push(harness);
		const source = harness.getModel("faux-1")!;
		const target = harness.getModel("faux-2")!;
		allowInline(source, [MP4]);
		allowInline(target, []);
		harness.setResponses([
			fauxAssistantMessage("seeded"),
			fauxAssistantMessage(fauxToolCall("make_video", {}), { stopReason: "toolUse" }),
			(context) => {
				expect(attachmentIds(context.messages)).toEqual([]);
				return fauxAssistantMessage("continued after consent");
			},
		]);

		await harness.session.prompt({ text: "seed", attachments: [attachment("att_old", "old.mp4", MP4)] });
		await harness.session.setModel(target, { allowLossy: true });
		await harness.session.prompt("make another video");

		expect(harness.session.getPendingPortabilityConfirmation()).toMatchObject({
			source: "mid-turn",
			report: { items: [expect.objectContaining({ attachmentId: toolVideo.id })] },
		});
		expect(harness.eventsOfType("portability_confirmation_required")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(attachmentIds(harness.session.messages)).toEqual(["att_old", toolVideo.id]);

		await harness.session.resolvePendingPortabilityConfirmation(true);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getPendingPortabilityConfirmation()).toBeUndefined();
		expect(harness.session.getLastAssistantText()).toBe("continued after consent");
	});

	it("keeps a declined mid-turn tool result and asks again on the next user ingress", async () => {
		const toolVideo = attachment("att_tool_declined", "declined.mp4", MP4);
		const tool: AgentTool = {
			name: "make_video",
			label: "Make video",
			description: "Create a video",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "created" }],
				details: {},
				attachments: [toolVideo],
			}),
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		const target = harness.session.model!;
		allowInline(target, []);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("make_video", {}), { stopReason: "toolUse" }),
			(context) => {
				expect(attachmentIds(context.messages)).toEqual([]);
				return fauxAssistantMessage("continued on next ingress");
			},
		]);

		await harness.session.prompt("make another video");
		await harness.session.resolvePendingPortabilityConfirmation(false);

		expect(harness.session.getPendingPortabilityConfirmation()).toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(attachmentIds(harness.session.messages)).toEqual([toolVideo.id]);

		let confirmations = 0;
		await harness.session.prompt("continue after decline", {
			confirmPortability: () => {
				confirmations += 1;
				return true;
			},
		});
		expect(confirmations).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("continued on next ingress");
	});

	it("rejects identity-less native state atomically instead of persisting partial consent", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
		});
		harnesses.push(harness);
		const source = harness.getModel("faux-1")!;
		const target = harness.getModel("faux-2")!;
		const sourceMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "opaque state" }],
			nativeParts: [
				{
					type: "provider-native" as const,
					provider: source.provider,
					api: source.api,
					modelId: source.id,
					kind: "identity-less",
					payload: { opaque: true },
				},
			],
			timestamp: Date.now(),
		};
		harness.sessionManager.appendMessage(sourceMessage);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		await expect(harness.session.setModel(target, { allowLossy: true })).rejects.toBeInstanceOf(
			PortabilityProjectionUnavailableError,
		);
		expect(harness.session.model).toBe(source);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "hifi.portability-decision"),
		).toHaveLength(0);
	});

	it("confirms a new prompt without replaying extension hooks or draining next-turn context", async () => {
		let inputCalls = 0;
		let beforeAgentCalls = 0;
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						inputCalls += 1;
						return { action: "continue" };
					});
					pi.on("before_agent_start", () => {
						beforeAgentCalls += 1;
					});
				},
			],
		});
		harnesses.push(harness);
		const source = harness.getModel("faux-1")!;
		const target = harness.getModel("faux-2")!;
		allowInline(source, [MP4]);
		allowInline(target, []);
		harness.setResponses([
			fauxAssistantMessage("seeded"),
			(context) => {
				expect(
					context.messages.some(
						(message) =>
							message.role === "user" &&
							typeof message.content !== "string" &&
							message.content.some((part) => part.type === "text" && part.text === "carry this"),
					),
				).toBe(true);
				return fauxAssistantMessage("confirmed");
			},
		]);
		await harness.session.prompt({ text: "seed", attachments: [attachment("att_old", "old.mp4", MP4)] });
		await harness.session.setModel(target, { allowLossy: true });
		inputCalls = 0;
		beforeAgentCalls = 0;
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);

		let confirmations = 0;
		await harness.session.prompt(
			{ text: "new video", attachments: [attachment("att_new", "new.mp4", MP4)] },
			{
				confirmPortability: async () => {
					confirmations += 1;
					return true;
				},
			},
		);

		expect(confirmations).toBe(1);
		expect(inputCalls).toBe(1);
		expect(beforeAgentCalls).toBe(1);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(true);
	});

	it("re-evaluates portability when a registry refresh changes the target identity", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
		});
		harnesses.push(harness);
		const source = harness.getModel("faux-1")!;
		const target = harness.getModel("faux-2")!;
		allowInline(source, [XLSX, MP4]);
		allowInline(target, [XLSX]);

		const spreadsheet = attachment("att_xlsx", "results.xlsx", XLSX);
		const video = attachment("att_mp4", "demo.mp4", MP4);
		harness.setResponses([fauxAssistantMessage("source saw files"), fauxAssistantMessage("target response")]);

		await harness.session.prompt({ text: "inspect both", attachments: [spreadsheet, video] });
		await harness.session.setModel(target, { allowLossy: true });
		expect(harness.session.getPortabilityProjection().decisionEntryId).toBeDefined();

		// A `registerProvider` override reaches the active model through a registry
		// refresh. The override must apply — that is the documented extension
		// contract — but it produces a different portability target, so the decision
		// approved for the previous identity must not carry over silently.
		const rotated = { ...target, baseUrl: "https://rotated.example/v1" };
		const runtime = harness.session.modelRuntime as unknown as { getModel: () => Model<any> };
		const originalGetModel = runtime.getModel;
		runtime.getModel = () => rotated;

		try {
			(
				harness.session as unknown as {
					_refreshCurrentModelFromRegistry(): void;
				}
			)._refreshCurrentModelFromRegistry();
		} finally {
			runtime.getModel = originalGetModel;
		}

		expect(harness.session.model?.baseUrl).toBe("https://rotated.example/v1");
		const projection = harness.session.getPortabilityProjection();
		expect(projection.decisionEntryId).toBeUndefined();
		expect(projection.suspendedItemIds).toEqual([]);
		expect(projection.unapprovedItemIds).toContain("attachment:att_mp4");
		expect(harness.session.getPendingPortabilityConfirmation()).toBeUndefined();
	});
});
