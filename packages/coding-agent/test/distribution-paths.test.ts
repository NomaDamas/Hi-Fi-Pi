import { describe, expect, it } from "vitest";
import {
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	LEGACY_ENV_AGENT_DIR,
	resolveAgentDir,
	USER_CONFIG_DIR_NAME,
} from "../src/config.ts";

describe("Hi-Fi Pi distribution paths", () => {
	it.each([
		["darwin", "/Users/alice", "/Users/alice/.hifipi/agent"],
		["linux", "/home/alice", "/home/alice/.hifipi/agent"],
	] as const)("defaults to an isolated user root on %s", (platform, homeDir, expected) => {
		expect(resolveAgentDir({ env: {}, homeDir, cwd: "/workspace", platform })).toEqual({
			path: expected,
			source: "default",
		});
	});

	it("uses Windows path semantics when requested", () => {
		expect(
			resolveAgentDir({ env: {}, homeDir: "C:\\Users\\alice", cwd: "C:\\workspace", platform: "win32" }),
		).toEqual({ path: "C:\\Users\\alice\\.hifipi\\agent", source: "default" });
	});

	it("expands a branded tilde override against the supplied home directory", () => {
		expect(
			resolveAgentDir({
				env: { [ENV_AGENT_DIR]: "~/profiles/research" },
				homeDir: "/Users/alice",
				cwd: "/workspace",
				platform: "darwin",
			}),
		).toEqual({
			path: "/Users/alice/profiles/research",
			source: "environment",
			environmentVariable: ENV_AGENT_DIR,
		});
	});

	it("prefers the branded override over the opt-in Pi compatibility override", () => {
		expect(
			resolveAgentDir({
				env: {
					[ENV_AGENT_DIR]: "/state/hifi",
					[LEGACY_ENV_AGENT_DIR]: "/state/pi",
				},
				homeDir: "/home/alice",
				cwd: "/workspace",
				platform: "linux",
			}),
		).toEqual({
			path: "/state/hifi",
			source: "environment",
			environmentVariable: ENV_AGENT_DIR,
		});
	});

	it("supports the upstream Pi override only when explicitly set", () => {
		expect(
			resolveAgentDir({
				env: { [LEGACY_ENV_AGENT_DIR]: "/state/pi" },
				homeDir: "/home/alice",
				cwd: "/workspace",
				platform: "linux",
			}),
		).toEqual({
			path: "/state/pi",
			source: "legacy-environment",
			environmentVariable: LEGACY_ENV_AGENT_DIR,
		});
	});

	it("keeps the project manifest directory separate from the user root", () => {
		expect(CONFIG_DIR_NAME).toBe(".pi");
		expect(USER_CONFIG_DIR_NAME).toBe(".hifipi");
	});
});
