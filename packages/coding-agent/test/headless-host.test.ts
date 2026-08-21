import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { PortabilityProjectionUnavailableError } from "../src/core/attachments/portability-projection.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createHeadlessAgentHost, HeadlessAgentHost } from "../src/headless.ts";

describe("headless agent host", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createHost(extensionFactory: ExtensionFactory): Promise<HeadlessAgentHost> {
		const directory = join(tmpdir(), `hifi-headless-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		const faux = registerFauxProvider();
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

	it("passes explicit lossy consent through without a second pause protocol", async () => {
		const prompt = vi.fn(async () => {});
		const runtime = {
			session: {
				prompt,
			},
		} as unknown as AgentSessionRuntime;
		const host = new HeadlessAgentHost(runtime);

		await host.prompt("run tool", { allowLossy: true });
		expect(prompt).toHaveBeenCalledWith("run tool", { allowLossy: true, source: "rpc" });
	});

	it("preserves an actionable mid-run portability failure for headless callers", async () => {
		const failure = new PortabilityProjectionUnavailableError(
			{
				target: {
					provider: "faux",
					api: "openai-responses",
					modelId: "faux-2",
					baseUrl: "https://faux.test/v1",
				},
				items: [
					{
						id: "attachment:att_video",
						stableId: "attachment:att_video",
						kind: "attachment",
						classification: "unsupported",
						reason: "video/mp4 is unsupported",
						projectable: true,
						attachmentId: "att_video",
						filename: "generated.mp4",
						messageIndex: 1,
					},
				],
				counts: { portable: 0, reconstructable: 0, "provider-locked": 0, missing: 0, unsupported: 1 },
				canSwitchWithoutLoss: false,
			},
			"mid-run",
		);
		const prompt = vi.fn(async () => {
			throw failure;
		});
		const host = new HeadlessAgentHost({ session: { prompt } } as unknown as AgentSessionRuntime);

		await expect(host.prompt("run tool")).rejects.toBe(failure);
		expect(failure.message).toMatch(/generated\.mp4.*not sent.*re-send.*switch/i);
	});
});
