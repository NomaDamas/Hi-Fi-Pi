import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkIndex = process.argv.indexOf("--sdk-dir");
const sdkDir = resolve(sdkIndex === -1 ? join(repoRoot, "release-assets", "sdk") : process.argv[sdkIndex + 1]);
const manifest = JSON.parse(readFileSync(join(sdkDir, "hifi-pi-sdk-manifest.json"), "utf8"));
if (!/^[0-9a-f]{40}$/.test(manifest.upstreamBaseCommit)) {
	throw new Error(`SDK manifest has an invalid upstream base: ${manifest.upstreamBaseCommit}`);
}
const root = mkdtempSync(join(tmpdir(), "hifi-pi-sdk-smoke-"));

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
	return result.stdout.trim();
}

try {
	writeFileSync(join(root, "package.json"), '{"name":"hifi-pi-clean-smoke","private":true,"type":"module"}\n');
	const tarballs = manifest.artifacts.map((artifact) => join(sdkDir, artifact.filename));
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], {
		cwd: root,
		env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
	});
	const installPackage = JSON.parse(readFileSync(join(sdkDir, manifest.install.packageJson), "utf8"));
	const installLock = JSON.parse(readFileSync(join(sdkDir, manifest.install.packageLock), "utf8"));
	for (const name of Object.keys(installPackage.dependencies)) {
		if (!name.startsWith("@nomadamas/hifi-pi-")) throw new Error(`Non-Hi-Fi install dependency: ${name}`);
	}
	if (JSON.stringify(installLock).includes("@earendil-works/")) {
		throw new Error("Hi-Fi SDK install lock contains an upstream package identity");
	}

	const binDir = join(root, "node_modules", ".bin");
	const executable = process.platform === "win32" ? join(binDir, "hifi-pi.cmd") : join(binDir, "hifi-pi");
	const upstreamExecutable = process.platform === "win32" ? join(binDir, "pi.cmd") : join(binDir, "pi");
	const userHome = join(root, "home");
	mkdirSync(userHome);
	const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, PATH: `${binDir}${delimiter}${process.env.PATH}` };
	const version = run(executable, ["--version"], { cwd: root, env });
	if (!version.startsWith("hifi-pi ") || !version.includes("(")) throw new Error(`Unexpected version: ${version}`);
	try {
		run(upstreamExecutable, ["--version"], { cwd: root, env });
		throw new Error("The Hi-Fi package unexpectedly installed a pi executable");
	} catch (error) {
		if (error.message.includes("unexpectedly installed")) throw error;
	}

	const packagePath = (id, ...segments) => {
		const artifact = manifest.artifacts.find((candidate) => candidate.id === id);
		if (!artifact?.packageName?.startsWith("@nomadamas/")) {
			throw new Error(`Missing fork-owned package identity for ${id}`);
		}
		const [scope, name] = artifact.packageName.split("/");
		return join(root, "node_modules", scope, name, ...segments);
	};
	const codingAgentUrl = pathToFileURL(packagePath("coding-agent", "dist", "index.js"));
	const aiUrl = pathToFileURL(packagePath("ai", "dist", "index.js"));
	const fauxUrl = pathToFileURL(
		packagePath("ai", "dist", "providers", "faux.js"),
	);
	const agentCoreUrl = pathToFileURL(packagePath("agent-core", "dist", "index.js"));
	const codingAgent = await import(codingAgentUrl.href);
	const ai = await import(aiUrl.href);
	const fauxApi = await import(fauxUrl.href);
	const agentCore = await import(agentCoreUrl.href);
	if (typeof codingAgent.DefaultResourceLoader !== "function") throw new Error("SDK resource loader is unavailable");

	const faux = fauxApi.createFauxCore({});
	faux.setResponses([fauxApi.fauxAssistantMessage("clean-text-prompt-ok")]);
	const agent = new agentCore.Agent({ streamFn: faux.stream, initialState: { model: faux.getModel() } });
	await agent.prompt("hello from a clean install");
	const response = agent.state.messages.at(-1)?.content?.find?.((part) => part.type === "text")?.text;
	if (response !== "clean-text-prompt-ok") throw new Error(`Clean text prompt failed: ${response}`);

	const projectDir = join(root, "extension-project");
	const extensionDir = join(projectDir, ".pi", "extensions");
	mkdirSync(extensionDir, { recursive: true });
	writeFileSync(
		join(extensionDir, "compat.ts"),
		'import { getModel } from "@earendil-works/pi-ai";\n' +
			'import { Text } from "@earendil-works/pi-tui";\n' +
			'export default function(pi) { pi.registerCommand("clean-compat", { description: `${typeof getModel}:${typeof Text}`, handler: async () => {} }); }\n',
	);
	const resourceLoader = new codingAgent.DefaultResourceLoader({ cwd: projectDir, agentDir: join(userHome, "agent") });
	await resourceLoader.reload({ resolveProjectTrust: async () => true });
	const extensionResult = resourceLoader.getExtensions();
	if (extensionResult.errors.length > 0 || !extensionResult.extensions[0]?.commands.has("clean-compat")) {
		throw new Error(`Clean Pi extension load failed: ${JSON.stringify(extensionResult.errors)}`);
	}
	if (extensionResult.extensions[0]?.commands.get("clean-compat")?.description !== "function:function") {
		throw new Error("Canonical Pi module aliases did not resolve through the Hi-Fi package");
	}

	const capability = ai.getNativeAttachmentCapability(
		{
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.5",
			baseUrl: "https://api.openai.com/v1",
		},
		"application/pdf",
		"path",
	);
	if (!capability.supported || capability.method !== "input_file") {
		throw new Error(`PDF native preflight failed: ${JSON.stringify(capability)}`);
	}

	console.log(
		JSON.stringify({
			version,
			textPrompt: response,
			extension: "clean-compat",
			pdfMethod: capability.method,
			upstreamBaseCommit: manifest.upstreamBaseCommit,
			artifacts: manifest.artifacts.length,
		}),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
