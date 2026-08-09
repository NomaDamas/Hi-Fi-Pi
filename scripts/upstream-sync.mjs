import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(repoRoot, ".github/upstream-baseline.json");

function git(args, options = {}) {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
	if (result.status !== 0 && !options.allowFailure) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function readBaseline() {
	return JSON.parse(readFileSync(baselinePath, "utf8"));
}

function option(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function ensureCommit(commit) {
	git(["cat-file", "-e", `${commit}^{commit}`]);
}

function setupRemote(baseline) {
	const current = git(["remote", "get-url", "upstream"], { allowFailure: true });
	if (current.status === 0) {
		git(["remote", "set-url", "upstream", baseline.remote]);
	} else {
		git(["remote", "add", "upstream", baseline.remote]);
	}
	// A deliberately invalid push URL makes accidental `git push upstream` fail.
	git(["remote", "set-url", "--push", "upstream", "DISABLED"]);
	console.log(JSON.stringify({ remote: "upstream", fetch: baseline.remote, push: "DISABLED" }, null, 2));
}

function parseChangedFiles(output) {
	if (!output) return [];
	return output.split("\n").map((line) => {
		const [status, ...pathParts] = line.split("\t");
		return { status, path: pathParts.at(-1) };
	});
}

function protectedChanges(files, surfaces) {
	return Object.fromEntries(
		Object.entries(surfaces).map(([surface, prefixes]) => [
			surface,
			files.filter((file) => prefixes.some((prefix) => file.path === prefix || file.path.startsWith(prefix))),
		]),
	);
}

function createReport(baseline, upstreamHead) {
	ensureCommit(baseline.baseCommit);
	ensureCommit(upstreamHead);
	const resolvedUpstreamHead = git(["rev-parse", upstreamHead]).stdout;
	const forkHead = git(["rev-parse", "HEAD"]).stdout;
	const mergeBase = git(["merge-base", "HEAD", resolvedUpstreamHead]).stdout;
	const files = parseChangedFiles(
		git(["diff", "--name-status", `${baseline.baseCommit}..${resolvedUpstreamHead}`]).stdout,
	);
	const rehearsal = git(["merge-tree", baseline.baseCommit, forkHead, resolvedUpstreamHead], {
		allowFailure: true,
	});
	const conflictLines = `${rehearsal.stdout}\n${rehearsal.stderr}`
		.split("\n")
		.filter((line) => /changed in both|CONFLICT|<<<<<<<|>>>>>>>/.test(line));
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		remote: baseline.remote,
		branch: baseline.branch,
		baselineCommit: baseline.baseCommit,
		forkHead,
		upstreamHead: resolvedUpstreamHead,
		mergeBase,
		upstreamCommitsSinceBaseline: Number(
			git(["rev-list", "--count", `${baseline.baseCommit}..${resolvedUpstreamHead}`]).stdout,
		),
		changedFiles: files,
		protectedChanges: protectedChanges(files, baseline.protectedSurfaces),
		conflicts: conflictLines,
		legacyContractCommand: "npm run test:upstream-compat",
		policy: {
			automaticMerge: false,
			forcePush: false,
			historyRewrite: false,
		},
	};
}

function writeReport(report, outputPath) {
	const destination = resolve(repoRoot, outputPath);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
	console.log(destination);
}

const command = process.argv[2] ?? "report";
const baseline = readBaseline();

if (command === "setup") {
	setupRemote(baseline);
} else if (command === "report") {
	setupRemote(baseline);
	if (process.argv.includes("--fetch")) {
		git(["fetch", "--no-tags", "upstream", baseline.branch]);
	}
	const upstreamHead = option("--head") ?? `refs/remotes/upstream/${baseline.branch}`;
	const report = createReport(baseline, upstreamHead);
	writeReport(report, option("--output") ?? ".artifacts/upstream-delta.json");
	if (process.argv.includes("--fail-on-conflict") && report.conflicts.length > 0) process.exitCode = 2;
} else if (command === "baseline") {
	const commit = option("--commit");
	if (!commit) throw new Error("baseline requires --commit <sha>");
	ensureCommit(commit);
	const resolvedCommit = git(["rev-parse", commit]).stdout;
	if (git(["merge-base", "--is-ancestor", resolvedCommit, "HEAD"], { allowFailure: true }).status !== 0) {
		throw new Error("The new upstream baseline must already be merged into HEAD");
	}
	writeFileSync(baselinePath, `${JSON.stringify({ ...baseline, baseCommit: resolvedCommit }, null, 2)}\n`);
	console.log(resolvedCommit);
} else {
	throw new Error(`Unknown upstream-sync command: ${command}`);
}
