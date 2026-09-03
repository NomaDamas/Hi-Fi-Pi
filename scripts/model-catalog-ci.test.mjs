import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const publishWorkflow = readFileSync(
	new URL("../.github/workflows/publish-model-catalog.yml", import.meta.url),
	"utf8",
);
const refreshWorkflow = readFileSync(
	new URL("../.github/workflows/refresh-model-data.yml", import.meta.url),
	"utf8",
);
const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
const thinkingContracts = readFileSync(
	new URL("../packages/ai/test/supports-xhigh.test.ts", import.meta.url),
	"utf8",
);

test("ordinary CI builds only from the checked-in model snapshot", () => {
	assert.match(ciWorkflow, /^\s+run: npm run build:offline$/m);
	assert.doesNotMatch(ciWorkflow, /^\s+run: npm run build$/m);
	assert.match(ciWorkflow, /^\s+workflow_dispatch:$/m);
});

test("live catalog publication is not a pull-request check", () => {
	assert.doesNotMatch(publishWorkflow, /^\s+pull_request:$/m);
});

test("scheduled model refreshes create reviewable snapshot pull requests", () => {
	assert.match(refreshWorkflow, /^\s+schedule:$/m);
	assert.match(refreshWorkflow, /^\s+workflow_dispatch:$/m);
	assert.match(refreshWorkflow, /^\s+contents: write$/m);
	assert.match(refreshWorkflow, /^\s+pull-requests: write$/m);
	assert.match(refreshWorkflow, /npm --prefix packages\/ai run generate-models/);
	assert.match(refreshWorkflow, /test\/supports-xhigh\.test\.ts/);
	assert.match(refreshWorkflow, /continue-on-error: true/);
	assert.match(refreshWorkflow, /gh pr create/);
	assert.match(refreshWorkflow, /gh workflow run ci\.yml/);
});

test("provider model values are versioned and opencode-go uses a pinned dialect contract", () => {
	assert.doesNotMatch(gitignore, /^packages\/ai\/src\/providers\/data\/$/m);
	assert.match(thinkingContracts, /expect\(model!\.api\)\.toBe\("openai-completions"\)/);
	assert.match(thinkingContracts, /expect\(getSupportedThinkingLevels\(model!\)\)\.toEqual\(\["off", "low", "high", "max"\]\)/);
});

test("cloudflare ai gateway snapshot keeps all three api groups", () => {
	// models.dev intermittently drops workers-ai/* passthroughs from its gateway
	// listing (2026-08-25). The generator re-derives them from the Workers AI
	// catalog; if that safeguard regresses, the openai-completions group empties
	// and the failure used to surface as an unrelated TS2353 in the provider
	// file. Fail here instead, naming what is missing.
	const gateway = JSON.parse(
		readFileSync(new URL("../packages/ai/src/providers/data/cloudflare-ai-gateway.json", import.meta.url), "utf8"),
	);
	assert.deepStrictEqual(Object.keys(gateway).sort(), [
		"anthropic-messages",
		"openai-completions",
		"openai-responses",
	]);
	const completionIds = Object.keys(gateway["openai-completions"]);
	assert.ok(completionIds.length > 0, "gateway openai-completions group is empty");
	assert.ok(
		completionIds.some((id) => id.startsWith("workers-ai/")),
		"gateway openai-completions carries no workers-ai/* passthroughs",
	);
});
