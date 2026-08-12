import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HIFI_PACKAGE_SCOPE = "@nomadamas";

export const HIFI_PACKAGES = [
	{ id: "telemetry", directory: "packages/telemetry", canonicalName: "@earendil-works/pi-telemetry" },
	{ id: "ai", directory: "packages/ai", canonicalName: "@earendil-works/pi-ai" },
	{ id: "tui", directory: "packages/tui", canonicalName: "@earendil-works/pi-tui" },
	{ id: "agent-core", directory: "packages/agent", canonicalName: "@earendil-works/pi-agent-core" },
	{ id: "protocol", directory: "packages/protocol", canonicalName: "@earendil-works/pi-protocol" },
	{ id: "client", directory: "packages/client", canonicalName: "@earendil-works/pi-client" },
	{
		id: "session-backend-sqlite-node",
		directory: "packages/session-backends/sqlite-node",
		canonicalName: "@earendil-works/pi-session-backend-sqlite-node",
	},
	{ id: "server", directory: "packages/server", canonicalName: "@earendil-works/pi-server" },
	{ id: "coding-agent", directory: "packages/coding-agent", canonicalName: "@earendil-works/pi-coding-agent" },
].map((entry) => ({ ...entry, packageName: `${HIFI_PACKAGE_SCOPE}/hifi-pi-${entry.id}` }));

const PACKAGE_NAME_MAP = new Map(HIFI_PACKAGES.map(({ canonicalName, packageName }) => [canonicalName, packageName]));
const MODULE_SPECIFIER_PATTERN =
	/(\bfrom\s*["']|\bimport\s*\(\s*["']|\bimport\s*["']|\brequire(?:\.resolve)?\s*\(\s*["']|\bimport\.meta\.resolve\s*\(\s*["'])(@earendil-works\/pi-[a-z0-9-]+)(\/[a-zA-Z0-9_./-]+)?(["'])/g;

export function hifiPackageName(canonicalName) {
	const packageName = PACKAGE_NAME_MAP.get(canonicalName);
	if (!packageName) throw new Error(`No Hi-Fi package identity is registered for ${canonicalName}`);
	return packageName;
}

function rewriteDependencyMap(dependencies) {
	if (!dependencies) return dependencies;
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, spec]) => [PACKAGE_NAME_MAP.get(name) ?? name, spec]),
	);
}

export function createHifiPackageManifest(sourceManifest, revision) {
	const packageName = hifiPackageName(sourceManifest.name);
	const manifest = {
		...sourceManifest,
		name: packageName,
		author: "Hi-Fi Pi contributors",
		repository: {
			type: "git",
			url: "git+https://github.com/NomaDamas/Hi-Fi-Pi.git",
			directory: HIFI_PACKAGES.find((entry) => entry.canonicalName === sourceManifest.name)?.directory,
		},
		bugs: { url: "https://github.com/NomaDamas/Hi-Fi-Pi/issues" },
		homepage: "https://github.com/NomaDamas/Hi-Fi-Pi",
		dependencies: rewriteDependencyMap(sourceManifest.dependencies),
		optionalDependencies: rewriteDependencyMap(sourceManifest.optionalDependencies),
		peerDependencies: rewriteDependencyMap(sourceManifest.peerDependencies),
		devDependencies: undefined,
		gitHead: revision,
	};

	if (sourceManifest.name === "@earendil-works/pi-ai") {
		manifest.bin = { "hifi-pi-ai": "dist/cli.js" };
	}

	return Object.fromEntries(Object.entries(manifest).filter(([, value]) => value !== undefined));
}

export function rewriteHifiModuleSpecifiers(source) {
	const rewritten = source.replace(
		MODULE_SPECIFIER_PATTERN,
		(_match, prefix, canonicalName, subpath = "", quote) =>
			`${prefix}${PACKAGE_NAME_MAP.get(canonicalName) ?? canonicalName}${subpath}${quote}`,
	);
	return rewritten.replace(
		/(\bresolveWorkspaceOrImport\s*\(\s*["'][^"']+["']\s*,\s*["'])(@earendil-works\/pi-[a-z0-9-]+)(\/[a-zA-Z0-9_./-]+)?(["'])/g,
		(_match, prefix, canonicalName, subpath = "", quote) =>
			`${prefix}${PACKAGE_NAME_MAP.get(canonicalName) ?? canonicalName}${subpath}${quote}`,
	);
}

function visitFiles(directory, callback) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) visitFiles(path, callback);
		else if (entry.isFile()) callback(path);
	}
}

export function prepareHifiPackageStage({ packageDir, stageDir, repoRoot, revision }) {
	cpSync(packageDir, stageDir, { recursive: true, filter: (source) => !source.includes("/node_modules/") });
	cpSync(join(repoRoot, "LICENSE"), join(stageDir, "LICENSE"));

	const sourceManifest = JSON.parse(readFileSync(join(stageDir, "package.json"), "utf8"));
	const manifest = createHifiPackageManifest(sourceManifest, revision);
	writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	// The source coding-agent shrinkwrap resolves canonical upstream workspace
	// identities. Release artifacts use the fork-only SDK install lock instead.
	rmSync(join(stageDir, "npm-shrinkwrap.json"), { force: true });

	const distDir = join(stageDir, "dist");
	visitFiles(distDir, (path) => {
		if (!/\.(?:js|d\.ts)$/.test(path)) return;
		const source = readFileSync(path, "utf8");
		let rewritten = rewriteHifiModuleSpecifiers(source);
		if (sourceManifest.name === "@earendil-works/pi-ai" && path.endsWith("/cli.js")) {
			rewritten = rewritten.replaceAll("npx @earendil-works/pi-ai", "npx @nomadamas/hifi-pi-ai");
		}
		if (rewritten !== source) writeFileSync(path, rewritten);
	});

	const readmePath = join(stageDir, "README.md");
	try {
		let readme = readFileSync(readmePath, "utf8");
		for (const [canonicalName, packageName] of PACKAGE_NAME_MAP) {
			readme = readme.replaceAll(canonicalName, packageName);
		}
		writeFileSync(readmePath, readme);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}

	return { manifest, sourceManifest };
}
