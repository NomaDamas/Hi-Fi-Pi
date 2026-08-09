import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AGENT_DEFINITION_SCHEMA_VERSION,
	AgentDefinitionRegistry,
	AgentDefinitionValidationError,
} from "../src/agent-definition.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("agent definition registry", () => {
	let directory: string;
	let registry: AgentDefinitionRegistry;
	let faux: ReturnType<typeof registerFauxProvider>;
	const hosts: Array<{ dispose(): Promise<void> }> = [];

	beforeEach(async () => {
		directory = join(tmpdir(), `hifi-agent-definition-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		faux = registerFauxProvider();
		const auth = AuthStorage.inMemory();
		await auth.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials: auth, modelsPath: join(directory, "models.json") });
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
		registry = new AgentDefinitionRegistry(modelRuntime);
	});

	afterEach(async () => {
		while (hosts.length > 0) await hosts.pop()?.dispose();
		faux.unregister();
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	});

	function definition(id: string, systemPrompt: string, tools: string[]) {
		return {
			schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
			id,
			version: "1.0.0",
			model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
			systemPrompt,
			tools,
			session: { mode: "memory" as const },
		};
	}

	it("creates independent research and coding sessions over one model runtime", async () => {
		registry.register(definition("research", "Research carefully.", []), { baseDirectory: directory });
		registry.register(definition("coding", "Edit code carefully.", ["read"]), { baseDirectory: directory });

		const research = await registry.create({ agentId: "research", cwd: directory, threadId: "thread-a" });
		const coding = await registry.create({ agentId: "coding", cwd: directory, threadId: "thread-b" });
		hosts.push(research.host, coding.host);

		expect(research.host.session.agent.state.systemPrompt).toContain("Research carefully.");
		expect(coding.host.session.agent.state.systemPrompt).toContain("Edit code carefully.");
		expect(research.host.session.getActiveToolNames()).toEqual([]);
		expect(coding.host.session.getActiveToolNames()).toEqual(["read"]);
		expect(research.host.session).not.toBe(coding.host.session);
		const metadata = research.host.session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "hifi.agent-definition");
		expect(metadata).toMatchObject({
			data: { agentId: "research", definitionVersion: "1.0.0", threadId: "thread-a" },
		});
	});

	it("loads product-owned definition files relative to their resources", () => {
		const skill = join(directory, "research-skill.md");
		writeFileSync(skill, "---\nname: research\ndescription: research\n---\nResearch instructions.");
		const definitionsPath = join(directory, "agents.json");
		writeFileSync(
			definitionsPath,
			JSON.stringify({
				definitions: [
					{
						...definition("research", "Research carefully.", []),
						resources: { skills: ["./research-skill.md"] },
					},
				],
			}),
		);

		expect(registry.loadFile(definitionsPath)).toHaveLength(1);
		expect(registry.resolve("research")).toMatchObject({ id: "research", version: "1.0.0" });
	});

	it("rejects unknown models and missing resources before session execution", async () => {
		registry.register(
			{
				...definition("unknown-model", "No model.", []),
				model: { provider: "missing", modelId: "missing" },
			},
			{ baseDirectory: directory },
		);
		await expect(registry.create({ agentId: "unknown-model", cwd: directory })).rejects.toThrow("unknown model");

		expect(() =>
			registry.register(
				{ ...definition("missing-resource", "No resource.", []), resources: { extensions: ["missing.ts"] } },
				{ baseDirectory: directory },
			),
		).toThrow(AgentDefinitionValidationError);
	});

	it("rejects unsupported schema versions and duplicate versions", () => {
		expect(() => registry.register({ ...definition("future", "Future.", []), schemaVersion: 2 })).toThrow(
			"schemaVersion",
		);
		registry.register(definition("research", "Research.", []), { baseDirectory: directory });
		expect(() => registry.register(definition("research", "Research.", []), { baseDirectory: directory })).toThrow(
			"already registered",
		);
	});
});
