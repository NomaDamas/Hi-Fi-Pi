import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = process.argv.indexOf("--out");
const outputDir = resolve(outputIndex === -1 ? join(repoRoot, "release-assets", "sdk") : process.argv[outputIndex + 1]);
function resolveRevision() {
	const configured = process.env.HIFI_PI_SOURCE_REVISION || process.env.GITHUB_SHA;
	if (configured) return configured;
	const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

const revision = resolveRevision();
const packages = [
	["ai", "packages/ai"],
	["agent-core", "packages/agent"],
	["tui", "packages/tui"],
	["coding-agent", "packages/coding-agent"],
	["server", "packages/server"],
	["storage-sqlite-node", "packages/storage/sqlite-node"],
];

mkdirSync(outputDir, { recursive: true });
const artifacts = [];
const npmCache = mkdtempSync(join(tmpdir(), "hifi-pi-pack-cache-"));
try {
	for (const [id, relativeDir] of packages) {
		const packageDir = resolve(repoRoot, relativeDir);
		const packageJsonPath = join(packageDir, "package.json");
		const originalPackageJson = readFileSync(packageJsonPath, "utf8");
		const metadata = JSON.parse(originalPackageJson);
		let result;
		try {
			writeFileSync(packageJsonPath, `${JSON.stringify({ ...metadata, gitHead: revision }, null, "\t")}\n`);
			result = spawnSync("npm", ["pack", packageDir, "--json", "--pack-destination", outputDir], {
				cwd: repoRoot,
				encoding: "utf8",
				env: { ...process.env, npm_config_cache: npmCache },
			});
		} finally {
			writeFileSync(packageJsonPath, originalPackageJson);
		}
		if (result.status !== 0) {
			throw new Error(result.stderr || result.stdout || `npm pack failed for ${metadata.name}`);
		}
		const packed = JSON.parse(result.stdout);
		const generatedName = packed[0]?.filename;
		if (!generatedName) throw new Error(`npm pack did not report an artifact for ${metadata.name}`);
		const filename = `hifi-pi-${id}-${metadata.version}.tgz`;
		renameSync(join(outputDir, generatedName), join(outputDir, filename));
		const bytes = readFileSync(join(outputDir, filename));
		artifacts.push({
			id,
			packageName: metadata.name,
			version: metadata.version,
			filename,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
	}
} finally {
	rmSync(npmCache, { recursive: true, force: true });
}

const manifest = {
	schemaVersion: 1,
	distribution: "hifi-pi",
	sourceRevision: revision,
	artifacts,
};
writeFileSync(join(outputDir, "hifi-pi-sdk-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
