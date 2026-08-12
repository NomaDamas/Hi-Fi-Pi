import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));
const workflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
const binaryScript = readFileSync(new URL("./build-binaries.sh", import.meta.url), "utf8");
const sourceScript = readFileSync(new URL("./create-source-archive.sh", import.meta.url), "utf8");
const sdkPackScript = readFileSync(new URL("./pack-hifi-sdk.mjs", import.meta.url), "utf8");
const packageIdentityScript = readFileSync(new URL("./hifi-package-identity.mjs", import.meta.url), "utf8");
const upstreamBaseline = JSON.parse(readFileSync(new URL("../.github/upstream-baseline.json", import.meta.url), "utf8"));

test("release layout installs only the branded executable", () => {
	assert.deepEqual(packageJson.bin, { "hifi-pi": "dist/cli.js" });
	assert.equal(Object.hasOwn(packageJson.bin, "pi"), false);
});

test("release workflow privately distributes SDK artifacts without upstream npm publishing", () => {
	assert.match(workflow, /hifi-pi-sdk-manifest\.json/);
	assert.match(workflow, /scripts\/smoke-hifi-sdk\.mjs/);
	assert.match(workflow, /scripts\/smoke-pi-ecosystem\.mjs/);
	assert.match(workflow, /npm run test:pi-compat/);
	assert.match(workflow, /test:native-input-contracts/);
	assert.doesNotMatch(workflow, /publish-npm:/);
	assert.doesNotMatch(workflow, /node scripts\/publish\.mjs/);
	assert.match(workflow, /hifi-pi-session-backend-sqlite-node-\$\{VERSION\}\.tgz/);
	assert.doesNotMatch(workflow, /hifi-pi-storage-sqlite-node/);
	assert.match(workflow, /hifi-pi-sdk-install-package-lock\.json/);
	assert.doesNotMatch(workflow, /hifi-pi-coding-agent-install-package/);
	assert.match(workflow, /--repo "\$\{GITHUB_REPOSITORY\}"/);
});

test("release package identities are fork-owned while source compatibility aliases remain canonical", () => {
	assert.match(packageIdentityScript, /@nomadamas/);
	assert.match(packageIdentityScript, /@earendil-works\/pi-coding-agent/);
	assert.match(sdkPackScript, /prepareHifiPackageStage/);
});

test("standalone and source artifacts use the Hi-Fi identity", () => {
	assert.match(binaryScript, /hifi-pi-darwin-arm64\.tar\.gz/);
	assert.match(binaryScript, /hifi-pi-windows-arm64\.zip/);
	assert.match(binaryScript, /hifi-pi\.exe/);
	assert.match(sourceScript, /archive_root="hifi-pi-\$\{version\}"/);
	assert.match(sourceScript, /\.github\/upstream-baseline\.json/);
});

test("hyphenated release tags are published as GitHub prereleases", () => {
	assert.match(workflow, /if \[\[ "\$\{VERSION\}" == \*-\* \]\]/);
	assert.match(workflow, /release_flags\+\=\(--prerelease\)/);
});

test("fork release metadata records the reviewed upstream base", () => {
	assert.match(upstreamBaseline.baseCommit, /^[0-9a-f]{40}$/);
	assert.match(sdkPackScript, /upstreamBaseCommit: upstreamBaseline\.baseCommit/);
});
