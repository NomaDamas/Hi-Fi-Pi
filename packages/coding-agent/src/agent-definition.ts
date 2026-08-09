import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolveProviderOptions } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./core/model-runtime.ts";
import { SessionManager } from "./core/session-manager.ts";
import { type CreateHeadlessAgentHostOptions, createHeadlessAgentHost, type HeadlessAgentHost } from "./headless.ts";
import type { ProductExtensionDescriptor, ProductPolicyEnforcer } from "./product/policy.ts";
import type { ProductIdentity } from "./product/storage.ts";

export const AGENT_DEFINITION_SCHEMA_VERSION = 1 as const;

export interface AgentDefinitionModelReference {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

export interface AgentDefinitionResources {
	extensions?: Array<string | ProductExtensionDescriptor>;
	skills?: string[];
	prompts?: string[];
}

export interface AgentDefinitionV1 {
	schemaVersion: typeof AGENT_DEFINITION_SCHEMA_VERSION;
	id: string;
	version: string;
	model: AgentDefinitionModelReference;
	systemPrompt?: string;
	tools?: string[];
	excludeTools?: string[];
	resources?: AgentDefinitionResources;
	workingDirectory?: { mode: "caller" } | { mode: "fixed"; path: string };
	session?: { mode: "memory" } | { mode: "persisted"; directory: string };
	providerOptions?: Record<string, unknown>;
}

export type AgentDefinition = AgentDefinitionV1;

interface RegisteredAgentDefinition {
	definition: AgentDefinition;
	baseDirectory: string;
}

export interface AgentDefinitionSelection {
	definition: AgentDefinition;
	baseDirectory: string;
}

export interface CreateDefinedAgentOptions {
	agentId: string;
	version?: string;
	cwd?: string;
	threadId?: string;
	sessionManager?: SessionManager;
	sessionDir?: string;
	onTrace?: CreateHeadlessAgentHostOptions["onTrace"];
	productIdentity?: ProductIdentity;
}

export interface CreatedDefinedAgent {
	definition: AgentDefinition;
	host: HeadlessAgentHost;
}

export class AgentDefinitionValidationError extends Error {
	constructor(message: string) {
		super(`Invalid agent definition: ${message}`);
		this.name = "AgentDefinitionValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AgentDefinitionValidationError(`${field} must be a non-empty string`);
	}
	return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
		throw new AgentDefinitionValidationError(`${field} must be an array of non-empty strings`);
	}
	return [...value];
}

function parseExtensionResources(value: unknown): Array<string | ProductExtensionDescriptor> | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new AgentDefinitionValidationError("resources.extensions must be an array");
	}
	return value.map((entry, index) => {
		if (typeof entry === "string" && entry.length > 0) return entry;
		if (!isRecord(entry)) {
			throw new AgentDefinitionValidationError(`resources.extensions[${index}] must be a string or object`);
		}
		const capabilities = optionalStringArray(entry.capabilities, `resources.extensions[${index}].capabilities`);
		if (capabilities?.some((capability) => !["filesystem", "process", "network", "tui"].includes(capability))) {
			throw new AgentDefinitionValidationError(`resources.extensions[${index}].capabilities is invalid`);
		}
		return {
			source: requireNonEmptyString(entry.source, `resources.extensions[${index}].source`),
			...(entry.version !== undefined
				? { version: requireNonEmptyString(entry.version, `resources.extensions[${index}].version`) }
				: {}),
			...(entry.integrity !== undefined
				? { integrity: requireNonEmptyString(entry.integrity, `resources.extensions[${index}].integrity`) }
				: {}),
			...(capabilities ? { capabilities: capabilities as ProductExtensionDescriptor["capabilities"] } : {}),
		};
	});
}

function parseResources(value: unknown): AgentDefinitionResources | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new AgentDefinitionValidationError("resources must be an object");
	return {
		extensions: parseExtensionResources(value.extensions),
		skills: optionalStringArray(value.skills, "resources.skills"),
		prompts: optionalStringArray(value.prompts, "resources.prompts"),
	};
}

export function parseAgentDefinition(value: unknown): AgentDefinition {
	if (!isRecord(value)) throw new AgentDefinitionValidationError("definition must be an object");
	if (value.schemaVersion !== AGENT_DEFINITION_SCHEMA_VERSION) {
		throw new AgentDefinitionValidationError(`schemaVersion must be ${AGENT_DEFINITION_SCHEMA_VERSION}`);
	}
	if (!isRecord(value.model)) throw new AgentDefinitionValidationError("model must be an object");
	const thinkingLevel = value.model.thinkingLevel;
	if (
		thinkingLevel !== undefined &&
		!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinkingLevel))
	) {
		throw new AgentDefinitionValidationError("model.thinkingLevel is invalid");
	}
	let workingDirectory: AgentDefinition["workingDirectory"];
	if (value.workingDirectory !== undefined) {
		if (!isRecord(value.workingDirectory)) {
			throw new AgentDefinitionValidationError("workingDirectory must be an object");
		}
		if (value.workingDirectory.mode === "caller") workingDirectory = { mode: "caller" };
		else if (value.workingDirectory.mode === "fixed") {
			workingDirectory = {
				mode: "fixed",
				path: requireNonEmptyString(value.workingDirectory.path, "workingDirectory.path"),
			};
		} else throw new AgentDefinitionValidationError("workingDirectory.mode must be caller or fixed");
	}
	let session: AgentDefinition["session"];
	if (value.session !== undefined) {
		if (!isRecord(value.session)) throw new AgentDefinitionValidationError("session must be an object");
		if (value.session.mode === "memory") session = { mode: "memory" };
		else if (value.session.mode === "persisted") {
			session = {
				mode: "persisted",
				directory: requireNonEmptyString(value.session.directory, "session.directory"),
			};
		} else throw new AgentDefinitionValidationError("session.mode must be memory or persisted");
	}
	if (value.providerOptions !== undefined && !isRecord(value.providerOptions)) {
		throw new AgentDefinitionValidationError("providerOptions must be an object");
	}
	return {
		schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
		id: requireNonEmptyString(value.id, "id"),
		version: requireNonEmptyString(value.version, "version"),
		model: {
			provider: requireNonEmptyString(value.model.provider, "model.provider"),
			modelId: requireNonEmptyString(value.model.modelId, "model.modelId"),
			...(thinkingLevel !== undefined ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
		},
		...(value.systemPrompt !== undefined
			? { systemPrompt: requireNonEmptyString(value.systemPrompt, "systemPrompt") }
			: {}),
		...(value.tools !== undefined ? { tools: optionalStringArray(value.tools, "tools") } : {}),
		...(value.excludeTools !== undefined
			? { excludeTools: optionalStringArray(value.excludeTools, "excludeTools") }
			: {}),
		...(value.resources !== undefined ? { resources: parseResources(value.resources) } : {}),
		...(workingDirectory ? { workingDirectory } : {}),
		...(session ? { session } : {}),
		...(value.providerOptions ? { providerOptions: structuredClone(value.providerOptions) } : {}),
	};
}

function readAgentDefinitionValues(path: string): { values: unknown[]; baseDirectory: string } {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
		throw new AgentDefinitionValidationError(`definition file does not exist: ${resolvedPath}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown;
	} catch (error) {
		throw new AgentDefinitionValidationError(
			`cannot parse ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const values = Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && Array.isArray(parsed.definitions)
			? parsed.definitions
			: [parsed];
	return { values, baseDirectory: dirname(resolvedPath) };
}

export function loadAgentDefinitionSelection(path: string, id: string, version?: string): AgentDefinitionSelection {
	const { values, baseDirectory } = readAgentDefinitionValues(path);
	const definitions = values.map(parseAgentDefinition);
	for (const definition of definitions) assertResourcesExist(definition, baseDirectory);
	const candidates = definitions.filter((definition) => definition.id === id);
	const selectedVersion =
		version ??
		candidates
			.map((definition) => definition.version)
			.sort(versionCompare)
			.at(-1);
	const definition = candidates.find((candidate) => candidate.version === selectedVersion);
	if (!definition) {
		throw new AgentDefinitionValidationError(`unknown agent definition: ${id}${version ? `@${version}` : ""}`);
	}
	return { definition: structuredClone(definition), baseDirectory };
}

export function resolveAgentDefinitionResources(selection: AgentDefinitionSelection): {
	extensions: ProductExtensionDescriptor[];
	skills: string[];
	prompts: string[];
} {
	return {
		extensions:
			selection.definition.resources?.extensions?.map((extension) =>
				resolveExtensionDescriptor(extension, selection.baseDirectory),
			) ?? [],
		skills:
			selection.definition.resources?.skills?.map((path) => resolveDefinitionPath(path, selection.baseDirectory)) ??
			[],
		prompts:
			selection.definition.resources?.prompts?.map((path) => resolveDefinitionPath(path, selection.baseDirectory)) ??
			[],
	};
}

function resolveDefinitionPath(path: string, baseDirectory: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(baseDirectory, path);
}

function extensionSource(extension: string | ProductExtensionDescriptor): string {
	return typeof extension === "string" ? extension : extension.source;
}

function resolveExtensionDescriptor(
	extension: string | ProductExtensionDescriptor,
	baseDirectory: string,
): ProductExtensionDescriptor {
	return typeof extension === "string"
		? { source: resolveDefinitionPath(extension, baseDirectory) }
		: { ...extension, source: resolveDefinitionPath(extension.source, baseDirectory) };
}

function assertResourcesExist(definition: AgentDefinition, baseDirectory: string): void {
	const resources = definition.resources;
	for (const extension of resources?.extensions ?? []) {
		const resolvedPath = resolveDefinitionPath(extensionSource(extension), baseDirectory);
		if (!existsSync(resolvedPath)) {
			throw new AgentDefinitionValidationError(`extensions resource does not exist: ${resolvedPath}`);
		}
	}
	for (const [kind, paths] of [
		["skills", resources?.skills],
		["prompts", resources?.prompts],
	] as const) {
		for (const path of paths ?? []) {
			const resolvedPath = resolveDefinitionPath(path, baseDirectory);
			if (!existsSync(resolvedPath)) {
				throw new AgentDefinitionValidationError(`${kind} resource does not exist: ${resolvedPath}`);
			}
		}
	}
}

function versionCompare(left: string, right: string): number {
	return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export class AgentDefinitionRegistry {
	private readonly definitions = new Map<string, Map<string, RegisteredAgentDefinition>>();
	readonly modelRuntime: ModelRuntime;
	private readonly policyEnforcer?: ProductPolicyEnforcer;

	constructor(modelRuntime: ModelRuntime, options: { policyEnforcer?: ProductPolicyEnforcer } = {}) {
		this.modelRuntime = modelRuntime;
		this.policyEnforcer = options.policyEnforcer;
	}

	register(value: unknown, options: { baseDirectory?: string } = {}): AgentDefinition {
		const definition = parseAgentDefinition(value);
		const baseDirectory = resolve(options.baseDirectory ?? process.cwd());
		assertResourcesExist(definition, baseDirectory);
		const versions = this.definitions.get(definition.id) ?? new Map<string, RegisteredAgentDefinition>();
		if (versions.has(definition.version)) {
			throw new AgentDefinitionValidationError(`${definition.id}@${definition.version} is already registered`);
		}
		versions.set(definition.version, { definition, baseDirectory });
		this.definitions.set(definition.id, versions);
		return structuredClone(definition);
	}

	loadFile(path: string): AgentDefinition[] {
		const { values, baseDirectory } = readAgentDefinitionValues(path);
		return values.map((definition) => this.register(definition, { baseDirectory }));
	}

	resolve(id: string, version?: string): AgentDefinition | undefined {
		const versions = this.definitions.get(id);
		if (!versions) return undefined;
		const selectedVersion = version ?? [...versions.keys()].sort(versionCompare).at(-1);
		const registered = selectedVersion ? versions.get(selectedVersion) : undefined;
		return registered ? structuredClone(registered.definition) : undefined;
	}

	list(): AgentDefinition[] {
		return [...this.definitions.values()]
			.flatMap((versions) => [...versions.values()].map(({ definition }) => structuredClone(definition)))
			.sort((left, right) => left.id.localeCompare(right.id) || versionCompare(left.version, right.version));
	}

	async create(options: CreateDefinedAgentOptions): Promise<CreatedDefinedAgent> {
		const versions = this.definitions.get(options.agentId);
		const selectedVersion =
			options.version ?? (versions ? [...versions.keys()].sort(versionCompare).at(-1) : undefined);
		const registered = selectedVersion ? versions?.get(selectedVersion) : undefined;
		if (!registered) {
			throw new AgentDefinitionValidationError(
				`unknown agent definition: ${options.agentId}${options.version ? `@${options.version}` : ""}`,
			);
		}
		const { definition, baseDirectory } = registered;
		const model = this.modelRuntime.getModel(definition.model.provider, definition.model.modelId);
		if (!model) {
			throw new AgentDefinitionValidationError(
				`unknown model: ${definition.model.provider}/${definition.model.modelId}`,
			);
		}
		resolveProviderOptions(model, definition.providerOptions ?? {}, { includeDefaults: false });
		const cwd =
			definition.workingDirectory?.mode === "fixed"
				? resolveDefinitionPath(definition.workingDirectory.path, baseDirectory)
				: resolve(options.cwd ?? baseDirectory);
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
			throw new AgentDefinitionValidationError(`working directory does not exist: ${cwd}`);
		}
		if (options.sessionManager && options.sessionDir) {
			throw new AgentDefinitionValidationError("use either sessionManager or sessionDir, not both");
		}
		const configuredSessionDir =
			definition.session?.mode === "persisted"
				? resolveDefinitionPath(definition.session.directory, baseDirectory)
				: undefined;
		const sessionManager =
			options.sessionManager ??
			(options.sessionDir || configuredSessionDir
				? SessionManager.create(cwd, resolve(options.sessionDir ?? configuredSessionDir!))
				: SessionManager.inMemory(cwd));
		const resources = definition.resources;
		const extensionDescriptors = resources?.extensions?.map((extension) =>
			resolveExtensionDescriptor(extension, baseDirectory),
		);
		if (extensionDescriptors && this.policyEnforcer) {
			if (!options.productIdentity) {
				throw new AgentDefinitionValidationError(
					"productIdentity is required when extension policy enforcement is enabled",
				);
			}
			this.policyEnforcer.assertExtensions(options.productIdentity, extensionDescriptors);
		}
		const host = await createHeadlessAgentHost({
			cwd,
			modelRuntime: this.modelRuntime,
			model,
			thinkingLevel: definition.model.thinkingLevel,
			tools: definition.tools,
			excludeTools: definition.excludeTools,
			providerOptions: definition.providerOptions,
			onTrace: options.onTrace,
			sessionManager,
			resourceLoaderOptions: {
				systemPrompt: definition.systemPrompt,
				additionalExtensionPaths: extensionDescriptors?.map((extension) => extension.source),
				additionalSkillPaths: resources?.skills?.map((path) => resolveDefinitionPath(path, baseDirectory)),
				additionalPromptTemplatePaths: resources?.prompts?.map((path) =>
					resolveDefinitionPath(path, baseDirectory),
				),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		host.session.sessionManager.appendCustomEntry("hifi.agent-definition", {
			schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
			agentId: definition.id,
			definitionVersion: definition.version,
			...(options.threadId ? { threadId: options.threadId } : {}),
		});
		return { definition: structuredClone(definition), host };
	}
}
