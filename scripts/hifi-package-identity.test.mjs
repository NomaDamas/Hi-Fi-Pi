import assert from "node:assert/strict";
import test from "node:test";
import {
	createHifiPackageManifest,
	HIFI_PACKAGES,
	prepareHifiPackageStage,
	rewriteHifiModuleSpecifiers,
} from "./hifi-package-identity.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("every published Hi-Fi artifact has a fork-owned package name", () => {
	assert.equal(HIFI_PACKAGES.length, 9);
	assert.equal(new Set(HIFI_PACKAGES.map((entry) => entry.packageName)).size, HIFI_PACKAGES.length);
	for (const entry of HIFI_PACKAGES) {
		assert.match(entry.packageName, /^@nomadamas\/hifi-pi-/);
		assert.doesNotMatch(entry.packageName, /earendil-works/);
	}
});

test("published manifests use fork dependencies and retain the branded executable", () => {
	const manifest = createHifiPackageManifest(
		{
			name: "@earendil-works/pi-coding-agent",
			version: "1.2.3",
			bin: { "hifi-pi": "dist/cli.js" },
			dependencies: {
				"@earendil-works/pi-ai": "^1.2.3",
				chalk: "5.6.2",
			},
			devDependencies: { vitest: "4.1.9" },
		},
		"a".repeat(40),
	);

	assert.equal(manifest.name, "@nomadamas/hifi-pi-coding-agent");
	assert.deepEqual(manifest.bin, { "hifi-pi": "dist/cli.js" });
	assert.deepEqual(manifest.dependencies, {
		"@nomadamas/hifi-pi-ai": "^1.2.3",
		chalk: "5.6.2",
	});
	assert.equal(manifest.devDependencies, undefined);
	assert.equal(manifest.repository.url, "git+https://github.com/NomaDamas/Hi-Fi-Pi.git");
});

test("artifact lowering rewrites runtime imports but preserves canonical extension alias keys", () => {
	const source = [
		'import { getModel } from "@earendil-works/pi-ai";',
		'const lazy = import("@earendil-works/pi-ai/compat");',
		'const resolved = require.resolve("@earendil-works/pi-coding-agent/rpc-entry");',
		'const entry = resolveWorkspaceOrImport("ai/dist/compat.js", "@earendil-works/pi-ai/compat");',
		'const aliases = { "@earendil-works/pi-ai": bundled };',
	].join("\n");
	const rewritten = rewriteHifiModuleSpecifiers(source);

	assert.match(rewritten, /from "@nomadamas\/hifi-pi-ai"/);
	assert.match(rewritten, /import\("@nomadamas\/hifi-pi-ai\/compat"\)/);
	assert.match(rewritten, /require\.resolve\("@nomadamas\/hifi-pi-coding-agent\/rpc-entry"\)/);
	assert.match(rewritten, /resolveWorkspaceOrImport\("ai\/dist\/compat\.js", "@nomadamas\/hifi-pi-ai\/compat"\)/);
	assert.match(rewritten, /"@earendil-works\/pi-ai": bundled/);
});

test("the live ecosystem npm script has a useful default SDK directory", () => {
	const source = readFileSync(new URL("./smoke-pi-ecosystem.mjs", import.meta.url), "utf8");
	assert.match(source, /release-assets\/sdk/);
});

test("artifact staging removes the canonical source shrinkwrap", () => {
	const root = mkdtempSync(join(tmpdir(), "hifi-package-stage-test-"));
	const packageDir = join(root, "packages", "coding-agent");
	const stageDir = join(root, "stage");
	try {
		mkdirSync(join(packageDir, "dist"), { recursive: true });
		writeFileSync(join(root, "LICENSE"), "test license\n");
		writeFileSync(
			join(packageDir, "package.json"),
			`${JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.2.3" })}\n`,
		);
		writeFileSync(join(packageDir, "npm-shrinkwrap.json"), '{"name":"@earendil-works/pi-coding-agent"}\n');
		writeFileSync(join(packageDir, "dist", "index.js"), "export {};\n");

		prepareHifiPackageStage({ packageDir, stageDir, repoRoot: root, revision: "a".repeat(40) });

		assert.equal(existsSync(join(stageDir, "npm-shrinkwrap.json")), false);
		const stagedManifest = JSON.parse(readFileSync(join(stageDir, "package.json"), "utf8"));
		assert.equal(stagedManifest.name, "@nomadamas/hifi-pi-coding-agent");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
