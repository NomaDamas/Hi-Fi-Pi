/**
 * Cold-start contracts for the fd/rg tool downloader.
 *
 * The concurrency test downloads real release archives, so it only runs when
 * COLD_START_TOOLS=1 (set by the dedicated CI job). The legacy-fallback test is
 * hermetic and always runs on POSIX platforms.
 */

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const POSIX = process.platform !== "win32";
const COLD_START = POSIX && process.env.COLD_START_TOOLS === "1";

const TOOLS_MANAGER_PATH = resolve(import.meta.dirname, "../src/utils/tools-manager.ts");

function whichPath(command: string): string {
	return execFileSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf-8" }).trim();
}

/** Shim PATH directory holding only the commands a download needs, so system fd/rg are never found. */
function createShimPath(root: string): string {
	const shimDir = join(root, "shim-bin");
	mkdirSync(shimDir, { recursive: true });
	symlinkSync(process.execPath, join(shimDir, "node"));
	for (const command of ["tar", "gzip", "sh"]) {
		symlinkSync(whichPath(command), join(shimDir, command));
	}
	return shimDir;
}

interface ChildResult {
	ok: boolean;
	output: string;
}

function runChild(script: string, env: Record<string, string>): Promise<ChildResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		child.on("close", (code) => {
			resolvePromise({ ok: code === 0 && output.includes("RESULT:ok"), output });
		});
	});
}

function ensureToolScript(tool: string): string {
	return `import(${JSON.stringify(TOOLS_MANAGER_PATH)}).then(async (m) => {
		const path = await m.ensureTool(${JSON.stringify(tool)}, true);
		if (!path) {
			console.log("RESULT:failed");
			process.exit(1);
		}
		console.log("RESULT:ok " + path);
	}).catch((error) => {
		console.log("RESULT:failed " + error);
		process.exit(1);
	});`;
}

describe.skipIf(!COLD_START)("cold-start tool download concurrency", () => {
	it("concurrent processes cold-downloading the same tool all succeed", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cold-start-"));
		try {
			const home = join(root, "home");
			mkdirSync(home, { recursive: true });
			const shimPath = createShimPath(root);
			const childEnv: Record<string, string> = {
				PATH: shimPath,
				HOME: home,
				TMPDIR: root,
				...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
			};

			const results = await Promise.all(Array.from({ length: 6 }, () => runChild(ensureToolScript("fd"), childEnv)));

			const failures = results.filter((result) => !result.ok);
			expect(failures.map((result) => result.output)).toEqual([]);
			expect(existsSync(join(home, ".hifipi", "agent", "bin", "fd"))).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 300_000);
});

describe.skipIf(!POSIX)("legacy Pi binary reuse", () => {
	it("resolves binaries from ~/.pi/agent/bin instead of cold-downloading", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-legacy-bin-"));
		try {
			const home = join(root, "home");
			const legacyBinDir = join(home, ".pi", "agent", "bin");
			mkdirSync(legacyBinDir, { recursive: true });
			const legacyBinary = join(legacyBinDir, "fd");
			writeFileSync(legacyBinary, "#!/bin/sh\necho fd-legacy\n");
			chmodSync(legacyBinary, 0o755);
			const shimDir = join(root, "shim-bin");
			mkdirSync(shimDir, { recursive: true });
			symlinkSync(process.execPath, join(shimDir, "node"));
			symlinkSync(whichPath("sh"), join(shimDir, "sh"));

			const script = `import(${JSON.stringify(TOOLS_MANAGER_PATH)}).then((m) => {
				const path = m.getToolPath("fd");
				if (path === ${JSON.stringify(legacyBinary)}) {
					console.log("RESULT:ok " + path);
				} else {
					console.log("RESULT:failed " + path);
					process.exit(1);
				}
			});`;
			const result = await runChild(script, { PATH: shimDir, HOME: home, TMPDIR: root });

			expect(result.ok ? "ok" : result.output).toBe("ok");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});
