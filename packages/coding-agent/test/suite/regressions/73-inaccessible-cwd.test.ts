import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, resolveAgentDir } from "../../../src/config.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Issue 73 inaccessible current-directory startup", () => {
	it("resolves the default agent directory without reading cwd", () => {
		vi.spyOn(process, "cwd").mockImplementation(() => {
			throw new Error("uv_cwd");
		});

		expect(resolveAgentDir({ env: {}, homeDir: "/Users/alice", platform: "darwin" })).toEqual({
			path: "/Users/alice/.hifipi/agent",
			source: "default",
		});
	});

	it("reports an actionable error when a relative agent-dir override requires inaccessible cwd", () => {
		vi.spyOn(process, "cwd").mockImplementation(() => {
			throw new Error("uv_cwd");
		});

		expect(() =>
			resolveAgentDir({
				env: { [ENV_AGENT_DIR]: "relative-agent" },
				homeDir: "/Users/alice",
				platform: "darwin",
			}),
		).toThrow(/current directory is not accessible.*accessible directory.*Files and Folders/is);
	});

	it("exits --version with a concise diagnostic when cwd is inaccessible", async () => {
		const root = mkdtempSync(join(tmpdir(), "hifi-pi-inaccessible-cwd-"));
		tempDirs.push(root);
		const helperPath = join(root, "run-cli.mjs");
		const cliUrl = pathToFileURL(resolve(__dirname, "../../../src/cli.ts")).href;
		writeFileSync(
			helperPath,
			'process.cwd = () => { const error = new Error("operation not permitted, uv_cwd"); error.code = "EPERM"; throw error; };\nawait import(process.env.HIFI_PI_TEST_CLI_URL);\n',
		);

		const result = await new Promise<{ code: number | null; stderr: string }>((resolveResult, reject) => {
			const child = spawn(process.execPath, [helperPath, "--version"], {
				cwd: root,
				env: {
					...process.env,
					HIFI_PI_TEST_CLI_URL: cliUrl,
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../tsconfig.json"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => resolveResult({ code, stderr }));
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/current directory is not accessible.*accessible directory.*Files and Folders/is);
		expect(result.stderr).not.toContain("uv_cwd");
		expect(result.stderr).not.toContain(" at ");
	});
});
