import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	type AgentDefinitionSelection,
	AgentDefinitionValidationError,
	loadAgentDefinitionSelection,
	resolveAgentDefinitionResources,
} from "../agent-definition.ts";
import type { Args } from "./args.ts";

export interface CliAgentDefinitionSelection {
	selection: AgentDefinitionSelection;
	cwd: string;
}

function selectedOverrideFlags(parsed: Args): string[] {
	return [
		parsed.provider ? "--provider" : undefined,
		parsed.model ? "--model" : undefined,
		parsed.systemPrompt ? "--system-prompt" : undefined,
		parsed.appendSystemPrompt ? "--append-system-prompt" : undefined,
		parsed.thinking ? "--thinking" : undefined,
		parsed.models ? "--models" : undefined,
		parsed.noTools ? "--no-tools" : undefined,
		parsed.noBuiltinTools ? "--no-builtin-tools" : undefined,
		parsed.tools ? "--tools" : undefined,
		parsed.excludeTools ? "--exclude-tools" : undefined,
		parsed.extensions ? "--extension" : undefined,
		parsed.skills ? "--skill" : undefined,
		parsed.promptTemplates ? "--prompt-template" : undefined,
		parsed.noSession ? "--no-session" : undefined,
		parsed.sessionDir ? "--session-dir" : undefined,
	].filter((flag): flag is string => flag !== undefined);
}

/** Resolve and apply the exact same versioned definition schema used by the SDK registry. */
export function applyAgentDefinitionToArgs(parsed: Args, startupCwd: string): CliAgentDefinitionSelection | undefined {
	if (!parsed.agent && !parsed.agentDefinitions && !parsed.agentVersion) return undefined;
	if (!parsed.agent || !parsed.agentDefinitions) {
		throw new AgentDefinitionValidationError("--agent and --agent-definitions must be used together");
	}
	const overrides = selectedOverrideFlags(parsed);
	if (overrides.length > 0) {
		throw new AgentDefinitionValidationError(
			`named agents cannot be combined with definition-owned overrides: ${overrides.join(", ")}`,
		);
	}
	const selection = loadAgentDefinitionSelection(
		resolve(startupCwd, parsed.agentDefinitions),
		parsed.agent,
		parsed.agentVersion,
	);
	const { definition, baseDirectory } = selection;
	if (
		definition.session?.mode !== "persisted" &&
		(parsed.session || parsed.sessionId || parsed.fork || parsed.continue || parsed.resume)
	) {
		throw new AgentDefinitionValidationError("memory-session agents cannot use session resume or fork flags");
	}
	const resources = resolveAgentDefinitionResources(selection);
	parsed.provider = definition.model.provider;
	parsed.model = `${definition.model.provider}/${definition.model.modelId}`;
	parsed.thinking = definition.model.thinkingLevel;
	parsed.systemPrompt = definition.systemPrompt;
	parsed.tools = definition.tools ? [...definition.tools] : undefined;
	parsed.excludeTools = definition.excludeTools ? [...definition.excludeTools] : undefined;
	parsed.extensions = resources.extensions.map((extension) => extension.source);
	parsed.skills = resources.skills;
	parsed.promptTemplates = resources.prompts;
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noPromptTemplates = true;
	parsed.noThemes = true;
	parsed.noContextFiles = true;
	if (definition.session?.mode === "persisted") {
		parsed.sessionDir = resolve(baseDirectory, definition.session.directory);
	} else {
		parsed.noSession = true;
	}
	const cwd =
		definition.workingDirectory?.mode === "fixed"
			? resolve(baseDirectory, definition.workingDirectory.path)
			: startupCwd;
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
		throw new AgentDefinitionValidationError(`working directory does not exist: ${cwd}`);
	}
	return { selection, cwd };
}
