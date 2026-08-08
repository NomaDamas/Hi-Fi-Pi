import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createPiStateImportPlan,
	executePiStateImport,
	IMPORTABLE_PI_RESOURCES,
} from "../src/cli/distribution-state.ts";

describe("explicit upstream Pi state import", () => {
	let root: string;
	let sourceAgentDir: string;
	let destinationAgentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hifi-pi-import-"));
		sourceAgentDir = join(root, ".pi", "agent");
		destinationAgentDir = join(root, ".hifipi", "agent");
		mkdirSync(join(sourceAgentDir, "skills", "example"), { recursive: true });
		writeFileSync(join(sourceAgentDir, "skills", "example", "SKILL.md"), "# Example\n");
		writeFileSync(join(sourceAgentDir, "auth.json"), '{"secret":"must-not-copy"}\n');
		mkdirSync(join(sourceAgentDir, "sessions"));
		writeFileSync(join(sourceAgentDir, "sessions", "session.jsonl"), "secret session\n");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("copies only explicitly selected resources", () => {
		const plan = createPiStateImportPlan({
			resources: ["skills"],
			sourceAgentDir,
			destinationAgentDir,
		});
		expect(plan.entries).toEqual([
			{
				resource: "skills",
				source: join(sourceAgentDir, "skills"),
				destination: join(destinationAgentDir, "skills"),
				status: "ready",
			},
		]);

		executePiStateImport(plan);

		expect(readFileSync(join(destinationAgentDir, "skills", "example", "SKILL.md"), "utf8")).toBe("# Example\n");
		expect(existsSync(join(destinationAgentDir, "auth.json"))).toBe(false);
		expect(existsSync(join(destinationAgentDir, "sessions"))).toBe(false);
	});

	it("does not expose credentials or sessions as importable resources", () => {
		expect(IMPORTABLE_PI_RESOURCES).not.toContain("auth");
		expect(IMPORTABLE_PI_RESOURCES).not.toContain("sessions");
	});

	it("never overwrites an existing destination", () => {
		mkdirSync(join(destinationAgentDir, "skills"), { recursive: true });
		writeFileSync(join(destinationAgentDir, "skills", "local.txt"), "keep\n");
		const plan = createPiStateImportPlan({
			resources: ["skills"],
			sourceAgentDir,
			destinationAgentDir,
		});
		expect(plan.entries[0]?.status).toBe("destination-exists");
		expect(executePiStateImport(plan)).toEqual([]);
		expect(readFileSync(join(destinationAgentDir, "skills", "local.txt"), "utf8")).toBe("keep\n");
	});

	it("reports missing selected sources without creating destination state", () => {
		const plan = createPiStateImportPlan({
			resources: ["themes"],
			sourceAgentDir,
			destinationAgentDir,
		});
		expect(plan.entries[0]?.status).toBe("missing-source");
		expect(executePiStateImport(plan)).toEqual([]);
		expect(existsSync(destinationAgentDir)).toBe(false);
	});
});
