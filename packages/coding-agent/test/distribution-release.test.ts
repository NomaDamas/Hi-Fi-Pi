import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
	APP_NAME,
	getInstallTelemetryUrl,
	getModelCatalogUrl,
	getSelfUpdateUrl,
	getShareViewerBaseUrl,
	getShareViewerUrl,
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

	it("requires explicit fork-owned service URLs", () => {
		expect(getShareViewerBaseUrl({})).toBeUndefined();
		expect(() => getShareViewerUrl("gist-123", {})).toThrow(/not configured/i);
		expect(getModelCatalogUrl({})).toBeUndefined();
		expect(getInstallTelemetryUrl({})).toBeUndefined();

		expect(getShareViewerUrl("gist-123", { HIFI_PI_SHARE_VIEWER_URL: "https://share.example.test/session/" })).toBe(
			"https://share.example.test/session/#gist-123",
		);
		expect(getShareViewerUrl("gist-123", { PI_SHARE_VIEWER_URL: "https://legacy.example.test/session/" })).toBe(
			"https://legacy.example.test/session/#gist-123",
		);
		expect(getModelCatalogUrl({ HIFI_PI_MODEL_CATALOG_URL: "https://catalog.example.test/" })).toBe(
			"https://catalog.example.test/",
		);
		expect(getInstallTelemetryUrl({ HIFI_PI_TELEMETRY_URL: "https://telemetry.example.test/report" })).toBe(
			"https://telemetry.example.test/report",
		);
	});

	it("does not advertise upstream branding or services in public READMEs", () => {
		for (const readme of [join(packageDir, "../../README.md"), join(packageDir, "README.md")]) {
			const contents = readFileSync(readme, "utf8");
			expect(contents).not.toContain("pi.dev");
			expect(contents).not.toContain("discord.com/invite/3cU7Bz4UPx");
			expect(contents).not.toContain("logo-auto.svg");
		}
	});

	it("preflights /share before checking GitHub auth or creating a gist", () => {
		const source = readFileSync(join(packageDir, "src/modes/interactive/interactive-mode.ts"), "utf8");
		const handlerStart = source.indexOf("private async handleShareCommand()");
		const handlerEnd = source.indexOf("private async handleCopyCommand", handlerStart);
		const handler = source.slice(handlerStart, handlerEnd);
		expect(handler.indexOf("getShareViewerBaseUrl()")).toBeGreaterThanOrEqual(0);
		expect(handler.indexOf("getShareViewerBaseUrl()")).toBeLessThan(handler.indexOf('spawnSync("gh"'));
		expect(handler.indexOf("getShareViewerBaseUrl()")).toBeLessThan(handler.indexOf('spawn("gh"'));
	});

	it("names standalone artifacts without claiming the pi executable", () => {
		const script = readFileSync(join(packageDir, "../../scripts/build-binaries.sh"), "utf8");
		expect(script).toContain("hifi-pi-darwin-arm64.tar.gz");
		expect(script).toContain("hifi-pi-windows-x64.zip");
		expect(script).toContain("$OUTPUT_DIR/$platform/hifi-pi");
		expect(script).not.toContain('$OUTPUT_DIR/$platform/pi"');
	});
});
