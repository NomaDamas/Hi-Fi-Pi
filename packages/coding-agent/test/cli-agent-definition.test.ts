import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_DEFINITION_SCHEMA_VERSION, AgentDefinitionRegistry } from "../src/agent-definition.ts";
import { applyAgentDefinitionToArgs } from "../src/cli/agent-definition.ts";
import { parseArgs } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("named agent CLI selection", () => {
	let directory: string;
	let definitionsPath: string;

	beforeEach(() => {
		directory = join(tmpdir(), `hifi-cli-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(directory, "work"), { recursive: true });
		writeFileSync(join(directory, "extension.ts"), "export default function extension() {}\n");
		writeFileSync(join(directory, "SKILL.md"), "---\nname: research\ndescription: test\n---\nResearch.\n");
		writeFileSync(join(directory, "prompt.md"), "Prompt template.\n");
		definitionsPath = join(directory, "agents.json");
		writeFileSync(
			definitionsPath,
			JSON.stringify({
				definitions: [
					{
						schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
						id: "research",
						version: "1.0.0",
						model: { provider: "faux", modelId: "old" },
					},
					{
						schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
						id: "research",
						version: "2.0.0",
						model: { provider: "openai", modelId: "gpt-5.4", thinkingLevel: "high" },
						systemPrompt: "Research carefully.",
						tools: ["read"],
						excludeTools: ["bash"],
						resources: {
							extensions: ["./extension.ts"],
							skills: ["./SKILL.md"],
							prompts: ["./prompt.md"],
						},
						workingDirectory: { mode: "fixed", path: "./work" },
						session: { mode: "persisted", directory: "./sessions" },
						providerOptions: { "openai.reasoning_effort": "high" },
					},
				],
			}),
		);
	});

	afterEach(() => {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	});

	it("applies the latest SDK definition to the normal CLI runtime inputs", async () => {
		const parsed = parseArgs(["--agent-definitions", definitionsPath, "--agent", "research", "hello"]);
		const selected = applyAgentDefinitionToArgs(parsed, directory);
		expect(selected?.selection.definition.version).toBe("2.0.0");
		expect(selected?.cwd).toBe(join(directory, "work"));
		expect(parsed).toMatchObject({
			provider: "openai",
			model: "openai/gpt-5.4",
			thinking: "high",
			systemPrompt: "Research carefully.",
			tools: ["read"],
			excludeTools: ["bash"],
			extensions: [join(directory, "extension.ts")],
			skills: [join(directory, "SKILL.md")],
			promptTemplates: [join(directory, "prompt.md")],
			sessionDir: join(directory, "sessions"),
			noExtensions: true,
			noContextFiles: true,
		});

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: join(directory, "models.json"),
		});
		const sdkRegistry = new AgentDefinitionRegistry(runtime);
		sdkRegistry.loadFile(definitionsPath);
		expect(sdkRegistry.resolve("research")).toEqual(selected?.selection.definition);
	});

	it("supports exact versions and rejects definition-owned CLI overrides", () => {
		const exact = parseArgs([
			"--agent-definitions",
			definitionsPath,
			"--agent",
			"research",
			"--agent-version",
			"1.0.0",
		]);
		expect(applyAgentDefinitionToArgs(exact, directory)?.selection.definition.model.modelId).toBe("old");

		const override = parseArgs([
			"--agent-definitions",
			definitionsPath,
			"--agent",
			"research",
			"--model",
			"openai/gpt-5.5",
		]);
		expect(() => applyAgentDefinitionToArgs(override, directory)).toThrow("definition-owned overrides");
	});

	it("rejects incomplete selection and resume flags for memory-session definitions", () => {
		expect(() => applyAgentDefinitionToArgs(parseArgs(["--agent", "research"]), directory)).toThrow(
			"must be used together",
		);
		const memory = parseArgs([
			"--agent-definitions",
			definitionsPath,
			"--agent",
			"research",
			"--agent-version",
			"1.0.0",
			"--continue",
		]);
		expect(() => applyAgentDefinitionToArgs(memory, directory)).toThrow("memory-session agents");
	});
});
