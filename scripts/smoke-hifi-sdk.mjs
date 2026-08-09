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

	const codingAgentUrl = pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
	const aiUrl = pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"));
	const fauxUrl = pathToFileURL(
		join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "faux.js"),
	);
	const agentCoreUrl = pathToFileURL(
		join(root, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js"),
	);
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
		'export default function(pi) { pi.registerCommand("clean-compat", { handler: async () => {} }); }\n',
	);
	const resourceLoader = new codingAgent.DefaultResourceLoader({ cwd: projectDir, agentDir: join(userHome, "agent") });
	await resourceLoader.reload({ resolveProjectTrust: async () => true });
	const extensionResult = resourceLoader.getExtensions();
	if (extensionResult.errors.length > 0 || !extensionResult.extensions[0]?.commands.has("clean-compat")) {
		throw new Error(`Clean Pi extension load failed: ${JSON.stringify(extensionResult.errors)}`);
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
