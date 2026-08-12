import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const PINNED_PACKAGES = [
	"pi-web-access@0.22.0",
	"pi-subagents@0.47.1",
	"pi-mcp-adapter@2.23.0",
	"@ff-labs/pi-fff@0.10.3",
	"pi-background-tasks@2.1.4",
	"pi-simplify@0.2.3",
];
const EXPECTED_REGISTRATIONS = new Map([
	["pi-web-access", { tool: "web_search", command: "websearch" }],
	["pi-subagents", { tool: "subagent", command: "subagents" }],
	["pi-mcp-adapter", { tool: "mcp", command: "mcp" }],
	["@ff-labs/pi-fff", { tool: "fffind", command: "fff-health" }],
	["pi-background-tasks", { tool: "bg_run", command: "bg" }],
	["pi-simplify", { command: "simplify" }],
]);

const sdkIndex = process.argv.indexOf("--sdk-dir");
if (sdkIndex === -1 || !process.argv[sdkIndex + 1]) {
	throw new Error("Usage: node scripts/smoke-pi-ecosystem.mjs --sdk-dir <release-sdk-directory>");
}
const sdkDir = resolve(process.argv[sdkIndex + 1]);
const manifest = JSON.parse(readFileSync(join(sdkDir, "hifi-pi-sdk-manifest.json"), "utf8"));
const root = mkdtempSync(join(tmpdir(), "hifi-pi-ecosystem-smoke-"));

function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: process.env });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
}

function installedPackagePath(name) {
	return join(root, "node_modules", ...name.split("/"));
}

function hifiPackagePath(id, ...segments) {
	const artifact = manifest.artifacts.find((candidate) => candidate.id === id);
	if (!artifact?.packageName?.startsWith("@nomadamas/")) {
		throw new Error(`Missing fork-owned package identity for ${id}`);
	}
	return join(installedPackagePath(artifact.packageName), ...segments);
}

try {
	writeFileSync(join(root, "package.json"), '{"name":"hifi-pi-ecosystem-smoke","private":true,"type":"module"}\n');
	const tarballs = manifest.artifacts.map((artifact) => join(sdkDir, artifact.filename));
	run("npm", [
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--legacy-peer-deps",
		...tarballs,
		...PINNED_PACKAGES,
	]);

	process.chdir(root);
	const codingAgent = await import(pathToFileURL(hifiPackagePath("coding-agent", "dist", "index.js")).href);
	const packageNames = PINNED_PACKAGES.map((spec) => spec.replace(/@[^@/]+$/, ""));
	const packagePaths = packageNames.map(installedPackagePath);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const loader = new codingAgent.DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager: codingAgent.SettingsManager.inMemory({ packages: packagePaths }),
	});
	await loader.reload({ resolveProjectTrust: async () => true });
	const extensionResult = loader.getExtensions();
	if (extensionResult.errors.length > 0) {
		throw new Error(`Real Pi package load failed: ${JSON.stringify(extensionResult.errors)}`);
	}

	for (const [packageName, expected] of EXPECTED_REGISTRATIONS) {
		const packageRoot = installedPackagePath(packageName);
		const extension = extensionResult.extensions.find((candidate) => candidate.path.startsWith(packageRoot));
		if (!extension) throw new Error(`${packageName} did not register an extension`);
		if (expected.tool && !extension.tools.has(expected.tool)) {
			throw new Error(`${packageName} did not register tool ${expected.tool}`);
		}
		if (!extension.commands.has(expected.command)) {
			throw new Error(`${packageName} did not register command ${expected.command}`);
		}
	}

	const targetName = "hifi-package-matrix-target.txt";
	writeFileSync(join(root, targetName), "Hi-Fi Pi ecosystem smoke\n");
	const fffExtension = extensionResult.extensions.find((candidate) =>
		candidate.path.startsWith(installedPackagePath("@ff-labs/pi-fff")),
	);
	const fffind = fffExtension?.tools.get("fffind")?.definition;
	if (!fffind) throw new Error("fffind tool is unavailable");
	const findResult = await fffind.execute(
		"ecosystem-smoke",
		{ pattern: targetName, limit: 10 },
		new AbortController().signal,
	);
	const resultText = findResult.content?.find((part) => part.type === "text")?.text;
	if (!resultText?.includes(targetName)) throw new Error(`fffind did not find the smoke fixture: ${resultText}`);

	console.log(
		JSON.stringify({
			packages: packageNames,
			extensions: extensionResult.extensions.length,
			tools: extensionResult.extensions.reduce((count, extension) => count + extension.tools.size, 0),
			commands: extensionResult.extensions.reduce((count, extension) => count + extension.commands.size, 0),
			hermeticTool: "fffind",
		}),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
