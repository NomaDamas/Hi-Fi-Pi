import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { HIFI_PACKAGES, prepareHifiPackageStage } from "./hifi-package-identity.mjs";

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
const upstreamBaseline = JSON.parse(readFileSync(resolve(repoRoot, ".github/upstream-baseline.json"), "utf8"));
mkdirSync(outputDir, { recursive: true });
const artifacts = [];
const npmCache = mkdtempSync(join(tmpdir(), "hifi-pi-pack-cache-"));
const stageRoot = mkdtempSync(join(tmpdir(), "hifi-pi-pack-stage-"));
const installPackageFilename = "hifi-pi-sdk-install-package.json";
const installLockFilename = "hifi-pi-sdk-install-package-lock.json";
try {
	for (const { id, directory, canonicalName, packageName } of HIFI_PACKAGES) {
		const packageDir = resolve(repoRoot, directory);
		const stageDir = join(stageRoot, id);
		const { manifest: metadata } = prepareHifiPackageStage({ packageDir, stageDir, repoRoot, revision });
		const result = spawnSync("npm", ["pack", stageDir, "--json", "--pack-destination", outputDir], {
			cwd: repoRoot,
			encoding: "utf8",
			env: { ...process.env, npm_config_cache: npmCache },
		});
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
			packageName,
			canonicalName,
			version: metadata.version,
			filename,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
	}

	const installPackage = {
		name: "hifi-pi-sdk-install",
		private: true,
		version: artifacts[0]?.version,
		dependencies: Object.fromEntries(
			artifacts.map((artifact) => [artifact.packageName, `file:./${artifact.filename}`]),
		),
	};
	writeFileSync(join(outputDir, "package.json"), `${JSON.stringify(installPackage, null, "\t")}\n`);
	const lockResult = spawnSync(
		"npm",
		["install", "--package-lock-only", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"],
		{
			cwd: outputDir,
			encoding: "utf8",
			env: { ...process.env, npm_config_cache: npmCache },
		},
	);
	if (lockResult.status !== 0) {
		throw new Error(lockResult.stderr || lockResult.stdout || "npm failed to create the Hi-Fi SDK install lock");
	}
	renameSync(join(outputDir, "package.json"), join(outputDir, installPackageFilename));
	renameSync(join(outputDir, "package-lock.json"), join(outputDir, installLockFilename));
} finally {
	rmSync(npmCache, { recursive: true, force: true });
	rmSync(stageRoot, { recursive: true, force: true });
}

const manifest = {
	schemaVersion: 2,
	distribution: "hifi-pi",
	sourceRevision: revision,
	upstreamBaseCommit: upstreamBaseline.baseCommit,
	artifacts,
	install: {
		packageJson: installPackageFilename,
		packageLock: installLockFilename,
	},
};
writeFileSync(join(outputDir, "hifi-pi-sdk-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
