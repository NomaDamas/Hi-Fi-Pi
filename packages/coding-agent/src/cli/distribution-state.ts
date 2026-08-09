import chalk from "chalk";
import { cpSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir } from "../config.ts";

export const IMPORTABLE_PI_RESOURCES = [
	"settings",
	"models",
	"keybindings",
	"extensions",
	"skills",
	"prompts",
	"themes",
] as const;

export type ImportablePiResource = (typeof IMPORTABLE_PI_RESOURCES)[number];

const IMPORT_RESOURCE_PATHS: Record<ImportablePiResource, string> = {
	settings: "settings.json",
	models: "models.json",
	keybindings: "keybindings.json",
	extensions: "extensions",
	skills: "skills",
	prompts: "prompts",
	themes: "themes",
};

export interface PiStateImportEntry {
	resource: ImportablePiResource;
	source: string;
	destination: string;
	status: "ready" | "missing-source" | "destination-exists";
}

export interface PiStateImportPlan {
	sourceAgentDir: string;
	destinationAgentDir: string;
	entries: PiStateImportEntry[];
}

export function createPiStateImportPlan(options: {
	resources: ImportablePiResource[];
	sourceAgentDir?: string;
	destinationAgentDir?: string;
}): PiStateImportPlan {
	const sourceAgentDir = resolve(options.sourceAgentDir ?? join(homedir(), ".pi", "agent"));
	const destinationAgentDir = resolve(options.destinationAgentDir ?? getAgentDir());
	return {
		sourceAgentDir,
		destinationAgentDir,
		entries: options.resources.map((resource) => {
			const relativePath = IMPORT_RESOURCE_PATHS[resource];
			const source = join(sourceAgentDir, relativePath);
			const destination = join(destinationAgentDir, relativePath);
			return {
				resource,
				source,
				destination,
				status: !existsSync(source) ? "missing-source" : existsSync(destination) ? "destination-exists" : "ready",
			};
		}),
	};
}

export function executePiStateImport(plan: PiStateImportPlan): PiStateImportEntry[] {
	const imported: PiStateImportEntry[] = [];
	for (const entry of plan.entries) {
		if (entry.status !== "ready") continue;
		mkdirSync(dirname(entry.destination), { recursive: true });
		cpSync(entry.source, entry.destination, { recursive: true, errorOnExist: true, force: false });
		imported.push(entry);
	}
	return imported;
}

function parseImportResources(values: string[]): {
	resources: ImportablePiResource[];
	invalid: string[];
} {
	const allowed = new Set<string>(IMPORTABLE_PI_RESOURCES);
	const resources: ImportablePiResource[] = [];
	const invalid: string[] = [];
	for (const value of values) {
		if (allowed.has(value)) {
			if (!resources.includes(value as ImportablePiResource)) resources.push(value as ImportablePiResource);
		} else {
			invalid.push(value);
		}
	}
	return { resources, invalid };
}

function printPaths(json: boolean): void {
	const paths = {
		userAgentDir: getAgentDir(),
		projectConfigDir: join(process.cwd(), CONFIG_DIR_NAME),
	};
	if (json) {
		console.log(JSON.stringify(paths, null, 2));
		return;
	}
	console.log(`User state: ${paths.userAgentDir}`);
	console.log(`Project resources: ${paths.projectConfigDir}`);
}

function printImportHelp(): void {
	console.log(`Usage:
  ${APP_NAME} import-pi <resource...> [--from <agent-dir>] [--dry-run]

Importable resources:
  ${IMPORTABLE_PI_RESOURCES.join(", ")}

Credentials, auth files, sessions, logs and attachment data are intentionally not importable.`);
}

export async function handleDistributionStateCommand(args: string[]): Promise<boolean> {
	if (args[0] === "paths") {
		const invalid = args.slice(1).filter((arg) => arg !== "--json");
		if (invalid.length > 0) {
			console.error(chalk.red(`Unknown paths option: ${invalid[0]}`));
			process.exitCode = 1;
			return true;
		}
		printPaths(args.includes("--json"));
		return true;
	}
	if (args[0] !== "import-pi") return false;

	if (args.includes("--help") || args.includes("-h")) {
		printImportHelp();
		return true;
	}
	let sourceAgentDir: string | undefined;
	let dryRun = false;
	const resourceArgs: string[] = [];
	for (let index = 1; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--from") {
			sourceAgentDir = args[++index];
			if (!sourceAgentDir) {
				console.error(chalk.red("--from requires an agent directory"));
				process.exitCode = 1;
				return true;
			}
		} else if (arg.startsWith("-")) {
			console.error(chalk.red(`Unknown import-pi option: ${arg}`));
			process.exitCode = 1;
			return true;
		} else {
			resourceArgs.push(arg);
		}
	}
	const parsed = parseImportResources(resourceArgs);
	if (parsed.invalid.length > 0) {
		console.error(chalk.red(`Resource is not importable: ${parsed.invalid.join(", ")}`));
		printImportHelp();
		process.exitCode = 1;
		return true;
	}
	if (parsed.resources.length === 0) {
		printImportHelp();
		process.exitCode = 1;
		return true;
	}

	const plan = createPiStateImportPlan({
		resources: parsed.resources,
		...(sourceAgentDir ? { sourceAgentDir } : {}),
	});
	console.log(`Source: ${plan.sourceAgentDir}`);
	console.log(`Destination: ${plan.destinationAgentDir}`);
	for (const entry of plan.entries) {
		console.log(`${entry.resource}: ${entry.status} (${basename(entry.source)})`);
	}
	if (dryRun) return true;

	const imported = executePiStateImport(plan);
	if (imported.length === 0) {
		console.error(chalk.yellow("Nothing was imported. Existing destinations are never overwritten."));
		process.exitCode = 1;
		return true;
	}
	console.log(chalk.green(`Imported: ${imported.map((entry) => entry.resource).join(", ")}`));
	return true;
}
