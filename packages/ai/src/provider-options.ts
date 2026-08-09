import {
	getProviderBackendContext,
	inspectProviderBackendSelection,
	type ProviderBackendContext,
	type ProviderBackendMatchValue,
	type ProviderOptionDefinition,
} from "./provider-backend.ts";
import type { Api, Model, StreamOptions } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateOpenAITextFormat(value: unknown): true | string {
	if (!isRecord(value) || value.type !== "json_schema") return "must be an OpenAI json_schema format object";
	if (typeof value.name !== "string" || value.name.length === 0) return "must include a non-empty name";
	if (!isRecord(value.schema)) return "must include a JSON Schema object";
	if (value.strict !== undefined && typeof value.strict !== "boolean") return "strict must be a boolean";
	return true;
}

const OPENAI_BUILT_IN_TOOL_TYPES = new Set([
	"web_search",
	"web_search_preview",
	"file_search",
	"code_interpreter",
	"computer_use_preview",
]);

function validateOpenAIBuiltInTools(value: unknown): true | string {
	if (!Array.isArray(value)) return "must be an array of OpenAI built-in tool definitions";
	for (const tool of value) {
		if (!isRecord(tool) || typeof tool.type !== "string" || !OPENAI_BUILT_IN_TOOL_TYPES.has(tool.type)) {
			return "contains an unsupported built-in tool type";
		}
	}
	return true;
}

const ANTHROPIC_SERVER_TOOL_TYPES = new Set([
	"web_search_20250305",
	"web_fetch_20250910",
	"code_execution_20250825",
	"code_execution_20260120",
	"computer_20250124",
	"computer_20251124",
]);

function validateAnthropicServerTools(value: unknown): true | string {
	if (!Array.isArray(value)) return "must be an array of Anthropic server tool definitions";
	for (const tool of value) {
		if (!isRecord(tool) || typeof tool.type !== "string" || !ANTHROPIC_SERVER_TOOL_TYPES.has(tool.type)) {
			return "contains an unsupported Anthropic server tool type";
		}
		if (typeof tool.name !== "string" || tool.name.length === 0) return "each server tool must include a name";
	}
	return true;
}

const OPENAI_OPTIONS: readonly ProviderOptionDefinition[] = [
	{
		key: "openai.responses.store",
		type: "boolean",
		description: "Persist the response on OpenAI's service.",
		default: false,
	},
	{
		key: "openai.responses.service_tier",
		type: "enum",
		description: "OpenAI Responses service tier.",
		allowedValues: ["auto", "default", "flex", "priority"],
	},
	{
		key: "openai.responses.previous_response_id",
		type: "string",
		description: "Continue from an explicit OpenAI Responses response ID.",
		pattern: "^\\S+$",
	},
	{
		key: "openai.responses.continue",
		type: "boolean",
		description: "Continue from the latest compatible response state in the conversation.",
		default: false,
	},
	{
		key: "openai.responses.text_format",
		type: "structured",
		description: "OpenAI Responses structured output format.",
		validate: validateOpenAITextFormat,
	},
	{
		key: "openai.responses.built_in_tools",
		type: "structured",
		description: "Official OpenAI built-in tools; remote MCP is intentionally excluded.",
		validate: validateOpenAIBuiltInTools,
	},
	{
		key: "openai.responses.background",
		type: "boolean",
		description: "Run the OpenAI response in background mode.",
		default: false,
	},
];

const ANTHROPIC_OPTIONS: readonly ProviderOptionDefinition[] = [
	{
		key: "anthropic.document.citations",
		type: "boolean",
		description: "Enable citations for native Anthropic document blocks.",
		default: false,
	},
	{
		key: "anthropic.cache_retention",
		type: "enum",
		description: "Anthropic prompt cache retention policy.",
		allowedValues: ["none", "short", "long"],
	},
	{
		key: "anthropic.server_tools",
		type: "structured",
		description: "Official Anthropic server-side tool definitions.",
		validate: validateAnthropicServerTools,
	},
	{
		key: "anthropic.context_management",
		type: "structured",
		description: "Anthropic context editing and management configuration.",
	},
];

const GOOGLE_OPTIONS: readonly ProviderOptionDefinition[] = [
	{
		key: "google.video.fps",
		type: "number",
		description: "Sampling frame rate attached to native Gemini video parts.",
		minimum: 0.1,
		maximum: 24,
	},
	{
		key: "google.thinking_budget",
		type: "number",
		description: "Gemini thinking token budget; -1 requests a dynamic budget.",
		minimum: -1,
		maximum: 1_000_000,
		integer: true,
		modelIds: /gemini/i,
	},
	{
		key: "google.cached_content",
		type: "string",
		description: "Gemini or Vertex cached content resource name.",
		pattern: "^(cachedContents/|projects/).+",
	},
	{
		key: "google.google_search",
		type: "boolean",
		description: "Enable the official Google Search grounding tool.",
		default: false,
	},
	{
		key: "google.url_context",
		type: "boolean",
		description: "Enable the official Gemini URL context tool.",
		default: false,
	},
	{
		key: "google.code_execution",
		type: "boolean",
		description: "Enable the official Gemini code execution tool.",
		default: false,
	},
];

export class ProviderOptionValidationError extends Error {
	readonly key?: string;
	readonly context: ProviderBackendContext;

	constructor(context: ProviderBackendContext, message: string, key?: string) {
		super(`Provider option error for ${context.provider}/${context.api}/${context.modelId}: ${message}`);
		this.name = "ProviderOptionValidationError";
		this.key = key;
		this.context = context;
	}
}

/** Stable persistence scope for controls whose validity depends on model and transport. */
export function getProviderOptionScope(model: Model<Api>): string {
	const context = getProviderBackendContext(model);
	let endpoint = context.baseUrl;
	try {
		const url = new URL(context.baseUrl);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		endpoint = url.toString().replace(/\/$/, "");
	} catch {
		// Custom runtimes may use a non-URL endpoint identifier. It remains part of the scope.
	}
	return `${context.provider}/${context.api}/${context.modelId}@${context.endpointProfile}:${endpoint}`;
}

function compatibilityDefinitions(context: ProviderBackendContext): readonly ProviderOptionDefinition[] {
	switch (context.endpointProfile) {
		case "openai-official":
			return context.api === "openai-responses" ? OPENAI_OPTIONS : [];
		case "anthropic-official":
			return ANTHROPIC_OPTIONS;
		case "gemini-developer-api":
		case "vertex-official":
			return GOOGLE_OPTIONS;
		default:
			return [];
	}
}

function matchesValue(actual: string, expected: ProviderBackendMatchValue | undefined): boolean {
	if (expected === undefined) return true;
	if (typeof expected === "string") return actual === expected;
	if (expected instanceof RegExp) return new RegExp(expected.source, expected.flags.replace(/[gy]/g, "")).test(actual);
	return expected.includes(actual);
}

function isSecretKey(key: string): boolean {
	const normalized = key.toLowerCase().replaceAll("-", "_");
	return /(?:^|\.)(?:authorization|password|secret|api_key|apikey|access_token|refresh_token|client_secret|credential)(?:$|\.)/.test(
		normalized,
	);
}

function containsSecretField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsSecretField);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, child]) => isSecretKey(key) || containsSecretField(child));
}

function assertJsonValue(value: unknown): void {
	if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
		throw new Error("value must be JSON-serializable");
	}
	if (typeof value === "number" && !Number.isFinite(value)) throw new Error("number must be finite");
	if (Array.isArray(value)) {
		for (const item of value) assertJsonValue(item);
		return;
	}
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) assertJsonValue(child);
	}
}

function validateValue(definition: ProviderOptionDefinition, value: unknown, context: ProviderBackendContext): unknown {
	try {
		assertJsonValue(value);
		if (containsSecretField(value))
			throw new Error("contains a secret-like field; use provider authentication instead");
		switch (definition.type) {
			case "boolean":
				if (typeof value !== "boolean") throw new Error("must be a boolean");
				break;
			case "number":
				if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("must be a finite number");
				if (definition.integer && !Number.isInteger(value)) throw new Error("must be an integer");
				if (definition.minimum !== undefined && value < definition.minimum)
					throw new Error(`must be at least ${definition.minimum}`);
				if (definition.maximum !== undefined && value > definition.maximum)
					throw new Error(`must be at most ${definition.maximum}`);
				break;
			case "string":
				if (typeof value !== "string") throw new Error("must be a string");
				if (definition.pattern && !new RegExp(definition.pattern).test(value))
					throw new Error(`must match ${definition.pattern}`);
				break;
			case "enum":
				if (!definition.allowedValues?.some((candidate) => Object.is(candidate, value))) {
					throw new Error(`must be one of ${(definition.allowedValues ?? []).map(String).join(", ")}`);
				}
				break;
			case "structured":
				if (!value || typeof value !== "object") throw new Error("must be an object or array");
				break;
		}
		const custom = definition.validate?.(value, context);
		if (custom !== undefined && custom !== true) throw new Error(custom);
	} catch (error) {
		throw new ProviderOptionValidationError(
			context,
			`${definition.key} ${error instanceof Error ? error.message : String(error)}`,
			definition.key,
		);
	}
	return structuredClone(value);
}

export function getProviderOptionDefinitions(model: Model<Api>): readonly ProviderOptionDefinition[] {
	const selection = inspectProviderBackendSelection(model);
	const definitions = selection.backend?.options ?? compatibilityDefinitions(selection.context);
	return definitions
		.filter((definition) => matchesValue(model.id, definition.modelIds))
		.map((definition) => ({
			...definition,
			...(definition.allowedValues ? { allowedValues: structuredClone(definition.allowedValues) } : {}),
		}));
}

export function resolveProviderOptions(
	model: Model<Api>,
	provided: Readonly<Record<string, unknown>> = {},
	options: { includeDefaults?: boolean } = { includeDefaults: true },
): Record<string, unknown> {
	const context = getProviderBackendContext(model);
	const definitions = getProviderOptionDefinitions(model);
	const byKey = new Map<string, ProviderOptionDefinition>(
		definitions.map((definition) => [definition.key, definition]),
	);
	const effective: Record<string, unknown> = {};
	if (options.includeDefaults ?? true) {
		for (const definition of definitions) {
			if (definition.default !== undefined) {
				effective[definition.key] = validateValue(definition, definition.default, context);
			}
		}
	}
	for (const [key, value] of Object.entries(provided)) {
		if (isSecretKey(key)) {
			throw new ProviderOptionValidationError(
				context,
				`${key} is secret-bearing and cannot be a provider option`,
				key,
			);
		}
		const definition = byKey.get(key);
		if (!definition) {
			throw new ProviderOptionValidationError(
				context,
				`${key} is unknown or unsupported for the selected backend/model`,
				key,
			);
		}
		effective[key] = validateValue(definition, value, context);
	}
	return effective;
}

/** Preserve the legacy options object when no namespaced controls were supplied. */
export function withResolvedProviderOptions<TOptions extends StreamOptions | undefined>(
	model: Model<Api>,
	options: TOptions,
): TOptions {
	if (!options?.providerOptions) return options;
	return {
		...options,
		providerOptions: resolveProviderOptions(model, options.providerOptions),
	} as TOptions;
}
