import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
	APP_NAME,
	getSelfUpdateUrl,
	getVersionString,
	SELF_UPDATE_ENABLED,
	SOURCE_REVISION,
	VERSION,
} from "../src/config.ts";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Hi-Fi Pi release identity", () => {
	it("installs only the hifi-pi executable", () => {
		const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
			bin: Record<string, string>;
		};
		expect(packageJson.bin).toEqual({ "hifi-pi": "dist/cli.js" });
		expect(packageJson.bin).not.toHaveProperty("pi");
	});

	it("identifies the fork version and source revision", () => {
		expect(APP_NAME).toBe("hifi-pi");
		expect(SOURCE_REVISION.length).toBeGreaterThan(0);
		expect(getVersionString()).toBe(`hifi-pi ${VERSION} (${SOURCE_REVISION})`);
	});

	it("does not use the upstream self-update channel by default", () => {
		expect(SELF_UPDATE_ENABLED).toBe(false);
		expect(getSelfUpdateUrl({})).toBeUndefined();
		expect(getSelfUpdateUrl({ HIFI_PI_SELF_UPDATE_URL: "https://releases.example.test/latest" })).toBe(
			"https://releases.example.test/latest",
		);
	});

	it("names standalone artifacts without claiming the pi executable", () => {
		const script = readFileSync(join(packageDir, "../../scripts/build-binaries.sh"), "utf8");
		expect(script).toContain("hifi-pi-darwin-arm64.tar.gz");
		expect(script).toContain("hifi-pi-windows-x64.zip");
		expect(script).toContain("$OUTPUT_DIR/$platform/hifi-pi");
		expect(script).not.toContain('$OUTPUT_DIR/$platform/pi"');
	});
});
