import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url);
const script = new URL("./upstream-sync.mjs", import.meta.url);
const source = readFileSync(script, "utf8");
const baseline = JSON.parse(readFileSync(new URL("../.github/upstream-baseline.json", import.meta.url), "utf8"));

function gitStatus() {
	return execFileSync("git", ["status", "--porcelain=v1"], { cwd: repoRoot, encoding: "utf8" });
}

test("upstream rehearsal is report-only and leaves tracked state untouched", () => {
	const root = mkdtempSync(join(tmpdir(), "hifi-pi-upstream-sync-"));
	try {
		const output = join(root, "report.json");
		const before = gitStatus();
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
		execFileSync(
			process.execPath,
			[script.pathname, "report", "--base", head, "--head", head, "--output", output],
			{
				cwd: repoRoot,
				stdio: "pipe",
			},
		);
		const after = gitStatus();
		const report = JSON.parse(readFileSync(output, "utf8"));

		assert.equal(after, before);
		assert.equal(report.schemaVersion, 1);
		assert.equal(report.baselineCommit, head);
		assert.equal(report.upstreamHead, head);
		assert.equal(report.upstreamCommitsSinceBaseline, 0);
		assert.deepEqual(report.changedFiles, []);
		assert.deepEqual(report.policy, {
			automaticMerge: false,
			forcePush: false,
			historyRewrite: false,
		});
		assert.deepEqual(Object.keys(report.protectedChanges), Object.keys(baseline.protectedSurfaces));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sync automation contains no mutating history or push command", () => {
	assert.doesNotMatch(source, /git\(\["(?:push|merge|rebase|reset|checkout)"/);
	assert.match(source, /set-url", "--push", "upstream", "DISABLED"/);
});
