import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureSource = join(testDir, "fixtures", "pi-ecosystem-package");

describe("versioned Pi ecosystem compatibility", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let fixtureDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "hifi-pi-ecosystem-"));
		agentDir = join(tempDir, ".hifipi", "agent");
		cwd = join(tempDir, "project");
		fixtureDir = join(tempDir, "pi-ecosystem-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		cpSync(fixtureSource, fixtureDir, { recursive: true });
		mkdirSync(join(fixtureDir, "themes"), { recursive: true });
		cpSync(join(testDir, "../src/modes/interactive/theme/dark.json"), join(fixtureDir, "themes", "compat.json"));
	});

	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	it("loads an unchanged package.json pi manifest across all resource surfaces", async () => {
		const manifest = JSON.parse(readFileSync(join(fixtureDir, "package.json"), "utf8")) as Record<string, unknown>;
		expect(manifest.pi).toEqual({
			extensions: ["./extensions/index.ts"],
			skills: ["./skills"],
			prompts: ["./prompts"],
			themes: ["./themes"],
		});
		expect(manifest).not.toHaveProperty("hifiPi");

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [fixtureDir] }),
		});
		await loader.reload();

		const extensionResult = loader.getExtensions();
		expect(extensionResult.errors).toEqual([]);
		expect(extensionResult.extensions).toHaveLength(1);
		expect(extensionResult.extensions[0]?.tools.has("compat_echo")).toBe(true);
		expect(extensionResult.extensions[0]?.commands.has("compat-ping")).toBe(true);
		expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("compat-skill");
		expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toContain("compat-prompt");
		expect(loader.getThemes().themes.map((theme) => theme.name)).toContain("dark");
	});

	it.each(["interactive", "rpc"] as const)(
		"preserves the legacy input event contract in %s sessions",
		async (source) => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ packages: [fixtureDir] }),
			});
			await loader.reload();
			const extensionResult = loader.getExtensions();
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			const modelRegistry = await createModelRegistry(authStorage);
			const runner = new ExtensionRunner(
				extensionResult.extensions,
				extensionResult.runtime,
				cwd,
				SessionManager.inMemory(),
				modelRegistry,
			);

			expect(await runner.emitInput("compat-ping", undefined, source)).toEqual({
				action: "transform",
				text: "compat-pong",
			});
			expect(runner.getToolDefinition("compat_echo")?.description).toContain("upstream-format Pi extension");
			expect(runner.getCommand("compat-ping")?.description).toBe("Compatibility command");
		},
	);

	it("keeps the compatibility matrix machine-readable and versioned", () => {
		const matrix = JSON.parse(readFileSync(join(testDir, "../docs/pi-ecosystem-compatibility.json"), "utf8")) as {
			schemaVersion: number;
			manifest: string;
			moduleIds: string[];
			surfaces: Record<string, unknown>;
		};
		expect(matrix.schemaVersion).toBe(1);
		expect(matrix.manifest).toBe("package.json#pi");
		expect(matrix.moduleIds).toContain("@earendil-works/pi-coding-agent");
		expect(Object.keys(matrix.surfaces)).toEqual(
			expect.arrayContaining(["extensions", "skills", "prompts", "themes", "packageSources"]),
		);
	});
});
