import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AttachmentRecord, Context, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	PortabilityConfirmationRequiredError,
	projectConversationForTarget,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	PortabilityProjectionCoordinator,
	PortabilityProjectionUnavailableError,
} from "../../../src/core/attachments/portability-projection.ts";
import { serializeConversation } from "../../../src/core/compaction/utils.ts";
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

function seedUnapprovedLossyHistory(harness: Harness, source: Model<string>): string {
	const now = Date.now();
	const targetId = harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "old native context" }],
		nativeParts: [
			{
				type: "provider-native",
				provider: source.provider,
				api: source.api,
				modelId: source.id,
				kind: "video-state",
				stateId: "state_unapproved",
				payload: { opaque: true },
			},
		],
		timestamp: now - 4_000,
	});
	const oldAssistant = fauxAssistantMessage("old answer", { timestamp: now - 3_000 });
	oldAssistant.usage = { ...oldAssistant.usage, input: 100, totalTokens: 100 };
	harness.sessionManager.appendMessage(oldAssistant);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "recent context" }],
		timestamp: now - 2_000,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage("recent answer", { timestamp: now - 1_000 }));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return targetId;
}

function useSummaryStream(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount += 1;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage(summary),
					api: model.api,
					provider: model.provider,
					model: model.id,
				},
			});
		});
		return stream;
	};
	return () => callCount;
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

		const steerPromise = harness.session.steer("steer", undefined, [steeredVideo], { allowLossy: true });
		expect(harness.session.pendingMessageCount).toBe(1);
		await steerPromise;

		const followUpPromise = harness.session.followUp("plain follow-up");
		expect(harness.session.pendingMessageCount).toBe(2);
		await followUpPromise;

		const followUpVideo = attachment("att_follow_up", "follow-up.mp4", MP4);
		let confirmations = 0;
		await harness.session.followUp("follow", undefined, [followUpVideo], {
			confirmPortability: () => {
				confirmations += 1;
				return true;
			},
		});
		expect(confirmations).toBe(1);
		expect(harness.session.pendingMessageCount).toBe(3);
		expect(harness.sessionManager.getAttachments().map((record) => record.id)).toEqual(
			expect.arrayContaining([steeredVideo.id, followUpVideo.id]),
		);
	});

	it.each(["steer", "followUp"] as const)(
		"keeps lossy consent on a %s delivered into a live run",
		async (delivery) => {
			let signalToolStarted = (): void => {};
			const toolStarted = new Promise<void>((resolve) => {
				signalToolStarted = resolve;
			});
			let releaseTool = (): void => {};
			const toolReleased = new Promise<void>((resolve) => {
				releaseTool = resolve;
			});
			const tool: AgentTool = {
				name: "block",
				label: "Block",
				description: "Wait for a queued portability input",
				parameters: Type.Object({}),
				execute: async () => {
					signalToolStarted();
					await toolReleased;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			};
			const harness = await createHarness({ tools: [tool] });
			harnesses.push(harness);
			allowInline(harness.session.model!, []);
			const video = attachment(`att_live_${delivery}`, `${delivery}.mp4`, MP4);
			const finalResponse = (context: Context) => {
				expect(attachmentIds(context.messages)).toEqual([]);
				const payload = JSON.stringify(context.messages);
				expect(payload.match(/attachment omitted/g)).toHaveLength(1);
				expect(payload).toContain(MP4);
				return fauxAssistantMessage(`${delivery} delivered`);
			};
			harness.setResponses(
				delivery === "steer"
					? [fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }), finalResponse]
					: [
							fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
							fauxAssistantMessage("tool turn complete"),
							finalResponse,
						],
			);

			const run = harness.session.prompt("start blocking tool");
			await toolStarted;
			await harness.session[delivery](delivery, undefined, [video], { allowLossy: true });
			releaseTool();
			await expect(run).resolves.toBeUndefined();

			expect(harness.session.getLastAssistantText()).toBe(`${delivery} delivered`);
			expect(harness.eventsOfType("portability_error")).toHaveLength(0);
			expect(harness.eventsOfType("portability_run_summary")).toEqual([
				expect.objectContaining({
					projection: expect.objectContaining({
						suspendedAttachmentIds: [video.id],
						unapprovedItemIds: [],
					}),
				}),
			]);
			expect(
				harness.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom" && entry.customType === "hifi.portability-decision"),
			).toHaveLength(0);
		},
	);

	it("rechecks resumed history when the target has no stored decision", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "hifi-portability-unapproved-resume-"));
		tempDirs.push(sessionDir);
		const manager = SessionManager.create(sessionDir, sessionDir);
		const video = attachment("att_resumed_video", "resumed.mp4", MP4);
		manager.appendAttachment(video);
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "remember this video" }],
			attachments: [{ type: "attachment", attachmentId: video.id }],
			timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("video remembered"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("persistent session file was not created");

		const reopened = SessionManager.open(sessionFile, sessionDir);
		const harness = await createHarness({
			sessionManager: reopened,
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
		harness.session.agent.state.messages = reopened.buildSessionContext().messages;
		harness.session.agent.state.model = target;
		expect(reopened.getAttachments().map((record) => record.id)).toEqual([video.id]);
		expect(harness.session.getPortabilityReport(target).items).toContainEqual(
			expect.objectContaining({ stableId: `attachment:${video.id}`, classification: "unsupported" }),
		);
		harness.setResponses([
			(context) => {
				expect(attachmentIds(context.messages)).toEqual([]);
				return fauxAssistantMessage("resumed safely");
			},
		]);

		let confirmations = 0;
		await harness.session.prompt("continue resumed session", {
			confirmPortability: () => {
				confirmations += 1;
				return true;
			},
		});

		expect(confirmations).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("resumed safely");
		expect(
			reopened
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "hifi.portability-decision"),
		).toHaveLength(1);
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

	it("keeps attachment omission disclosure in compaction serialization", () => {
		const target = {
			id: "faux-target",
			name: "Target",
			api: "openai-responses",
			provider: "faux",
			baseUrl: "https://faux.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		} satisfies Model<"openai-responses">;
		const video: AttachmentRecord = {
			id: "att_compaction_video",
			filename: "private-demo.mp4",
			mediaType: MP4,
			source: { type: "path", path: "/secret/project/private-demo.mp4" },
		};
		const projection = projectConversationForTarget({
			messages: [
				{
					role: "user",
					content: "summarize the video",
					attachments: [{ type: "attachment", attachmentId: video.id }],
					timestamp: 1,
				},
			],
			attachments: [video],
			target,
			approvedItemIds: [`attachment:${video.id}`],
		});

		const serialized = serializeConversation(projection.messages);
		expect(serialized.match(/attachment omitted/g)).toHaveLength(1);
		expect(serialized).toContain("summarize the video\n(video/mp4 attachment omitted:");
		expect(serialized).toContain("video/mp4");
		expect(serialized).not.toMatch(/\/secret|private-demo/);
	});

	it("manually compacts an unapproved lossy history without requiring ingress consent", async () => {
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
		seedUnapprovedLossyHistory(harness, source);
		harness.session.agent.state.model = target;
		const streamCalls = useSummaryStream(harness, "manual summary");

		await expect(harness.session.compact()).resolves.toMatchObject({
			summary: expect.stringContaining("manual summary"),
		});
		expect(streamCalls()).toBeGreaterThan(0);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it.each([
		["threshold", false],
		["overflow", true],
	] as const)("auto-compacts an unapproved lossy history for %s recovery", async (reason, willRetry) => {
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
		seedUnapprovedLossyHistory(harness, source);
		harness.session.agent.state.model = target;
		const streamCalls = useSummaryStream(harness, `${reason} summary`);

		const internals = harness.session as unknown as {
			_runAutoCompaction(reason: "threshold" | "overflow", willRetry: boolean): Promise<boolean>;
		};
		await expect(internals._runAutoCompaction(reason, willRetry)).resolves.toBe(willRetry);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason,
			aborted: false,
			willRetry,
		});
		expect(streamCalls()).toBeGreaterThan(0);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("summarizes an abandoned branch containing unapproved lossy state", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "Source" },
				{ id: "faux-2", name: "Target" },
			],
		});
		harnesses.push(harness);
		const source = harness.getModel("faux-1")!;
		const target = harness.getModel("faux-2")!;
		const targetId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "branch root" }],
			timestamp: Date.now() - 6_000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("root answer", { timestamp: Date.now() - 5_000 }));
		seedUnapprovedLossyHistory(harness, source);
		harness.session.agent.state.model = target;
		const streamCalls = useSummaryStream(harness, "branch summary");

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.summaryEntry?.summary).toContain("branch summary");
		expect(streamCalls()).toBe(1);
	});

	it("fails closed when a tool creates an incompatible attachment and preserves the canonical result", async () => {
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
		await expect(harness.session.prompt("make another video")).rejects.toMatchObject({
			name: "PortabilityProjectionUnavailableError",
			message: expect.stringMatching(/generated\.mp4.*not sent.*faux-2.*re-send.*switch/i),
		});
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(attachmentIds(harness.session.messages)).toEqual(["att_old", toolVideo.id]);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				toolCallId: expect.any(String),
				attachments: [{ type: "attachment", attachmentId: toolVideo.id }],
			}),
		);
		expect(harness.eventsOfType("portability_error")).toEqual([
			expect.objectContaining({
				kind: "portability_projection_unavailable",
				message: expect.stringContaining("generated.mp4"),
				report: expect.objectContaining({
					items: [expect.objectContaining({ attachmentId: toolVideo.id })],
				}),
			}),
		]);

		let confirmations = 0;
		await harness.session.prompt("continue after tool result", {
			confirmPortability: () => {
				confirmations += 1;
				return true;
			},
		});
		expect(confirmations).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getLastAssistantText()).toBe("continued after consent");
	});

	it("keeps explicit run-scoped lossy consent for attachments created by tools", async () => {
		const toolVideo = attachment("att_tool_allowed", "generated-allowed.mp4", MP4);
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
		allowInline(harness.session.model!, []);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("make_video", {}), { stopReason: "toolUse" }),
			(context) => {
				expect(attachmentIds(context.messages)).toEqual([]);
				const payload = JSON.stringify(context.messages);
				expect(payload.match(/attachment omitted/g)).toHaveLength(1);
				expect(payload).toContain("video/mp4");
				expect(payload).not.toMatch(/generated-allowed\.mp4|YXR0X3Rvb2xfYWxsb3dlZC1ieXRlcw==/);
				return fauxAssistantMessage("continued with standing consent");
			},
			(context) => {
				expect(attachmentIds(context.messages)).toEqual([]);
				return fauxAssistantMessage("continued after explicit confirmation");
			},
		]);

		await expect(harness.session.prompt("make a video", { allowLossy: true })).resolves.toBeUndefined();

		expect(harness.session.getLastAssistantText()).toBe("continued with standing consent");
		expect(harness.eventsOfType("portability_error")).toHaveLength(0);
		expect(attachmentIds(harness.session.messages)).toEqual([toolVideo.id]);
		expect(harness.eventsOfType("portability_projection").at(-1)?.projection).toMatchObject({
			suspendedAttachmentIds: [toolVideo.id],
			unapprovedItemIds: [],
		});
		expect(harness.eventsOfType("portability_run_summary")).toEqual([
			expect.objectContaining({
				projection: expect.objectContaining({
					suspendedAttachmentIds: [toolVideo.id],
					unapprovedItemIds: [],
				}),
			}),
		]);
		expect(harness.session.getPortabilityProjection().suspendedAttachmentIds).toEqual([]);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "hifi.portability-decision"),
		).toHaveLength(0);

		let confirmations = 0;
		await harness.session.prompt("continue normally", {
			confirmPortability: (error) => {
				confirmations += 1;
				expect(error.report.items.map((item) => item.attachmentId)).toEqual([toolVideo.id]);
				return true;
			},
		});
		expect(confirmations).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("continued after explicit confirmation");
	});

	it("persists only item IDs that a confirmation callback actually displayed", async () => {
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
				return fauxAssistantMessage("confirmed exact IDs");
			},
		]);
		await harness.session.prompt({ text: "seed", attachments: [attachment("att_old", "old.mp4", MP4)] });
		await harness.session.setModel(target, { allowLossy: true });

		const displayedItemIds: string[][] = [];
		await harness.session.prompt(
			{ text: "new video", attachments: [attachment("att_new", "new.mp4", MP4)] },
			{
				confirmPortability: (error) => {
					displayedItemIds.push(error.report.items.map((item) => item.stableId));
					if (displayedItemIds.length === 1) {
						harness.session.agent.state.messages.push({
							role: "user",
							content: [{ type: "text", text: "late provider state" }],
							nativeParts: [
								{
									type: "provider-native",
									provider: source.provider,
									api: source.api,
									modelId: source.id,
									kind: "late-state",
									stateId: "late_state_1",
									payload: { opaque: true },
								},
							],
							timestamp: Date.now(),
						});
					}
					return true;
				},
			},
		);

		expect(displayedItemIds[0]).toEqual(["attachment:att_new"]);
		expect(displayedItemIds[1]).toHaveLength(1);
		const lateStableId = displayedItemIds[1]?.[0];
		expect(lateStableId).toMatch(/^provider-native:faux:faux:.*:faux-1:late-state:late_state_1$/);
		const decisions = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "hifi.portability-decision");
		const latest = decisions.at(-1);
		expect(latest?.type).toBe("custom");
		if (latest?.type !== "custom") throw new Error("portability decision was not persisted");
		expect((latest.data as { approvedItemIds: string[] }).approvedItemIds).toEqual(
			expect.arrayContaining(["attachment:att_old", "attachment:att_new", lateStableId]),
		);
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
		allowInline(source, [MP4]);
		allowInline(target, []);
		const projectableVideo = attachment("att_projectable_first", "projectable.mp4", MP4);
		harness.setResponses([fauxAssistantMessage("seeded")]);
		await harness.session.prompt({ text: "seed projectable item", attachments: [projectableVideo] });
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
		harness.session.agent.state.model = target;
		let confirmations = 0;
		await expect(
			harness.session.prompt("must not ask for impossible consent", {
				confirmPortability: () => {
					confirmations += 1;
					return true;
				},
			}),
		).rejects.toMatchObject({
			name: "PortabilityProjectionUnavailableError",
			message: expect.stringMatching(/^(?!.*approve).*identity-less/i),
			report: {
				items: [expect.objectContaining({ kind: "provider-native", projectable: false })],
			},
		});
		expect(confirmations).toBe(0);
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
		const observedContexts: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage("source saw files"),
			(context) => {
				observedContexts.push(attachmentIds(context.messages));
				return fauxAssistantMessage("target response");
			},
		]);

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

		let confirmations = 0;
		await harness.session.prompt("continue on rotated endpoint", {
			confirmPortability: () => {
				confirmations += 1;
				return true;
			},
		});
		expect(confirmations).toBe(1);
		expect(observedContexts).toEqual([["att_xlsx"]]);
	});
});
