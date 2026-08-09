import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codingAgentDir = resolve(repoRoot, "packages/coding-agent");

function readOption(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function resolveRevision() {
	const configured = process.env.HIFI_PI_SOURCE_REVISION || process.env.GITHUB_SHA;
	if (configured) return configured;
	const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

const target = readOption("--target");
const outfileOption = readOption("--outfile") ?? "dist/hifi-pi";
const outfile = resolve(codingAgentDir, outfileOption);
const revision = resolveRevision();
const args = [
	"build",
	"--compile",
	...(target ? [`--target=${target}`] : []),
	"./dist/bun/cli.js",
	"./src/utils/image-resize-worker.ts",
	"--outfile",
	outfile,
	"--define",
	`HIFI_PI_BUILD_REVISION=${JSON.stringify(revision)}`,
];
const result = spawnSync("bun", args, { cwd: codingAgentDir, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
