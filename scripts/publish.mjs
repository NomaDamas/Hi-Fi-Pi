#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HIFI_PACKAGES, prepareHifiPackageStage } from "./hifi-package-identity.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(
			output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`,
		);
	}

	return result;
}

function resolveRevision() {
	const configured = process.env.HIFI_PI_SOURCE_REVISION || process.env.GITHUB_SHA;
	if (configured) return configured;
	const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(
		`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`,
	);
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

const revision = resolveRevision();
const stageRoot = mkdtempSync(join(tmpdir(), "hifi-pi-publish-stage-"));

try {
	// Publish the fork's own artifacts, never the upstream `@earendil-works/*`
	// names the workspace manifests carry. Staging applies the same identity
	// rewrite as `pack-hifi-sdk.mjs`, so what is published matches the tarballs
	// attached to a release.
	const staged = HIFI_PACKAGES.map(({ id, directory }) => {
		const packageDir = resolve(repoRoot, directory);
		assertBuildOutputExists(packageDir);
		const stageDir = join(stageRoot, id);
		const { manifest } = prepareHifiPackageStage({ packageDir, stageDir, repoRoot, revision });
		return { id, stageDir, name: manifest.name, version: manifest.version };
	});

	const versions = [...new Set(staged.map((pkg) => pkg.version))];
	if (versions.length !== 1) {
		throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
	}

	console.log(`Publishing Hi-Fi Pi packages at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);

	for (const pkg of staged) {
		pkg.published = isPublished(pkg.name, pkg.version);
		console.log(
			pkg.published
				? `${pkg.name}@${pkg.version} is already published; validating package contents only.`
				: `${pkg.name}@${pkg.version} is not published; validating package contents before publish.`,
		);
		validatePack(pkg.stageDir);
		console.log();
	}

	if (dryRun) {
		process.exit(0);
	}

	console.log("All packages validated; starting publication.\n");

	for (const pkg of staged) {
		if (pkg.published) {
			console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
			continue;
		}

		run("npm", ["publish", "--access", "public", "--provenance", "--ignore-scripts"], { cwd: pkg.stageDir });
		console.log();
	}
} finally {
	rmSync(stageRoot, { recursive: true, force: true });
}
