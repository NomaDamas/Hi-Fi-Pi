import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createHeadlessAgentHost, type HeadlessAgentHost } from "../src/headless.ts";

describe("headless agent host", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createHost(
		extensionFactory: ExtensionFactory,
		configureFaux?: (faux: FauxProviderRegistration) => void,
	): Promise<HeadlessAgentHost> {
		const directory = join(tmpdir(), `hifi-headless-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		const faux = registerFauxProvider();
		configureFaux?.(faux);
		const auth = AuthStorage.inMemory();
		await auth.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: auth,
			modelsPath: join(directory, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
					nativeInputs: model.nativeInputs,
				},
			],
		});
		const host = await createHeadlessAgentHost({
			cwd: directory,
			agentDir: directory,
			modelRuntime,
			model,
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		cleanups.push(async () => {
			await host.dispose();
			faux.unregister();
			if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
		});
		return host;
	}

	it("runs Pi extension input events without constructing a TUI", async () => {
		const observed: Array<{ text: string; attachmentIds: string[] }> = [];
		const host = await createHost((pi) => {
			pi.on("input", (event) => {
				observed.push({
					text: event.text,
					attachmentIds: event.attachments?.map((attachment) => attachment.attachmentId) ?? [],
				});
				return { action: "handled" };
			});
		});

		await host.prompt({
			text: "analyze",
			attachments: [
				{
					id: "att_pdf",
					filename: "paper.pdf",
					mediaType: "application/pdf",
					source: { type: "base64", data: "JVBERg==" },
				},
			],
		});

		expect(observed).toEqual([{ text: "analyze", attachmentIds: ["att_pdf"] }]);
		expect(host.session.agent.attachmentRegistry?.resolve("att_pdf")).toMatchObject({ filename: "paper.pdf" });
	});

	it("keeps concurrent hosts and their extension state independent", async () => {
		const first: string[] = [];
		const second: string[] = [];
		const firstHost = await createHost((pi) => {
			pi.on("input", (event) => {
				first.push(event.text);
				return { action: "handled" };
			});
		});
		const secondHost = await createHost((pi) => {
			pi.on("input", (event) => {
				second.push(event.text);
				return { action: "handled" };
			});
		});

		await Promise.all([firstHost.prompt("first"), secondHost.prompt("second")]);

		expect(first).toEqual(["first"]);
		expect(second).toEqual(["second"]);
		expect(firstHost.session).not.toBe(secondHost.session);
		expect(firstHost.session.sessionManager).not.toBe(secondHost.session.sessionManager);
	});

	it("disposes idempotently and rejects later prompts", async () => {
		const host = await createHost((pi) => {
			pi.on("input", () => ({ action: "handled" }));
		});
		await host.dispose();
		await host.dispose();
		await expect(host.prompt("late prompt")).rejects.toThrow("disposed");
	});

	it("fails closed on a real incompatible tool result and preserves actionable guidance", async () => {
		const attachment = {
			id: "att_headless_blocked",
			filename: "generated.mp4",
			mediaType: "video/mp4",
			source: { type: "base64" as const, data: "Z2VuZXJhdGVk" },
		};
		const host = await createHost(
			(pi) => {
				pi.registerTool({
					name: "make_video",
					label: "Make video",
					description: "Create a test video",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "created" }],
						details: {},
						attachments: [attachment],
					}),
				});
			},
			(faux) => {
				faux.getModel().nativeInputs = { profile: "headless-no-files", capabilities: [] };
				faux.setResponses([fauxAssistantMessage(fauxToolCall("make_video", {}), { stopReason: "toolUse" })]);
			},
		);

		await expect(host.prompt("run tool")).rejects.toMatchObject({
			name: "PortabilityProjectionUnavailableError",
			phase: "mid-run",
			message: expect.stringMatching(/generated\.mp4.*not sent.*re-send.*switch/i),
		});
	});

	it("applies a headless lossy opt-in to the real provider request and reports the omission", async () => {
		const attachment = {
			id: "att_headless_allowed",
			filename: "generated-allowed.mp4",
			mediaType: "video/mp4",
			source: { type: "base64" as const, data: "Z2VuZXJhdGVk" },
		};
		const host = await createHost(
			(pi) => {
				pi.registerTool({
					name: "make_video",
					label: "Make video",
					description: "Create a test video",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "created" }],
						details: {},
						attachments: [attachment],
					}),
				});
			},
			(faux) => {
				faux.getModel().nativeInputs = { profile: "headless-no-files", capabilities: [] };
				faux.setResponses([
					fauxAssistantMessage(fauxToolCall("make_video", {}), { stopReason: "toolUse" }),
					(context) => {
						const payload = JSON.stringify(context.messages);
						expect(payload).not.toContain(attachment.id);
						expect(payload).toContain("video/mp4 attachment omitted");
						return fauxAssistantMessage("done");
					},
				]);
			},
		);
		const summaries: string[] = [];
		host.subscribe((event) => {
			if (event.type === "portability_run_summary") summaries.push(event.projection.suspendedAttachmentIds[0] ?? "");
		});

		await expect(host.prompt("run tool", { allowLossy: true })).resolves.toBeUndefined();
		expect(host.session.getLastAssistantText()).toBe("done");
		expect(summaries).toEqual([attachment.id]);
	});
});
