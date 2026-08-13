import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type Model,
	PortabilityConfirmationRequiredError,
	type ProviderTraceCallback,
} from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEventListener, PromptInput, PromptOptions } from "./core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./core/agent-session-runtime.ts";
import {
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import type { SessionStartEvent, ToolDefinition } from "./core/extensions/index.ts";
import type { ModelRuntime } from "./core/model-runtime.ts";
import type { DefaultResourceLoaderOptions, ResourceLoaderReloadOptions } from "./core/resource-loader.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import { SessionManager } from "./core/session-manager.ts";

export interface CreateHeadlessAgentHostOptions {
	/** Explicit product or application working directory. */
	cwd: string;
	agentDir?: string;
	modelRuntime?: ModelRuntime;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	excludeTools?: string[];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
	providerOptions?: Record<string, unknown>;
	onTrace?: ProviderTraceCallback;
	/** Use an existing manager to resume, or omit it for a fresh session. */
	sessionManager?: SessionManager;
	/** Persist a fresh session under this directory. Omit for an in-memory session. */
	sessionDir?: string;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
	extensionFlagValues?: Map<string, boolean | string>;
	sessionStartEvent?: SessionStartEvent;
}

/**
 * Stable non-TUI host over the existing AgentSession and extension runtime.
 * It deliberately owns no agent loop of its own.
 */
export class HeadlessAgentHost {
	readonly runtime: AgentSessionRuntime;
	private disposed = false;

	constructor(runtime: AgentSessionRuntime) {
		this.runtime = runtime;
	}

	get session(): AgentSession {
		return this.runtime.session;
	}

	get cwd(): string {
		return this.runtime.cwd;
	}

	async prompt(input: string | PromptInput, options?: PromptOptions): Promise<void> {
		if (this.disposed) throw new Error("Headless agent host is disposed");
		await this.session.prompt(input, { ...options, source: options?.source ?? "rpc" });
		let pending = this.session.getPendingPortabilityConfirmation();
		while (pending) {
			const error = new PortabilityConfirmationRequiredError(pending.report);
			const confirmed = options?.allowLossy === true || (await options?.confirmPortability?.(error)) === true;
			if (!confirmed) {
				await this.session.resolvePendingPortabilityConfirmation(false);
				throw error;
			}
			await this.session.resolvePendingPortabilityConfirmation(true);
			pending = this.session.getPendingPortabilityConfirmation();
		}
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		if (this.disposed) throw new Error("Headless agent host is disposed");
		return this.session.subscribe(listener);
	}

	abort(): Promise<void> {
		return this.session.abort();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.runtime.dispose();
	}
}

export async function createHeadlessAgentHost(options: CreateHeadlessAgentHostOptions): Promise<HeadlessAgentHost> {
	if (options.sessionManager && options.sessionDir) {
		throw new Error("Use either sessionManager or sessionDir, not both");
	}
	let sharedModelRuntime = options.modelRuntime;
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const serviceOptions: CreateAgentSessionServicesOptions = {
			cwd,
			agentDir,
			modelRuntime: sharedModelRuntime,
			resourceLoaderOptions: options.resourceLoaderOptions,
			resourceLoaderReloadOptions: options.resourceLoaderReloadOptions,
			extensionFlagValues: options.extensionFlagValues,
		};
		const services = await createAgentSessionServices(serviceOptions);
		sharedModelRuntime = services.modelRuntime;
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			tools: options.tools,
			excludeTools: options.excludeTools,
			noTools: options.noTools,
			customTools: options.customTools,
			onTrace: options.onTrace,
			providerOptions: options.providerOptions,
		});
		return { ...result, services, diagnostics: services.diagnostics };
	};
	const sessionManager =
		options.sessionManager ??
		(options.sessionDir
			? SessionManager.create(options.cwd, options.sessionDir)
			: SessionManager.inMemory(options.cwd));
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: options.cwd,
		agentDir: options.agentDir ?? "",
		sessionManager,
		sessionStartEvent: options.sessionStartEvent,
	});
	await runtime.session.bindExtensions({ mode: "rpc" });
	runtime.setRebindSession(async (session) => {
		await session.bindExtensions({ mode: "rpc" });
	});
	return new HeadlessAgentHost(runtime);
}

export {
	AgentSession,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type PortabilityConfirmationState,
	type PromptInput,
	type PromptOptions,
} from "./core/agent-session.ts";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./core/agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
export { ModelRuntime } from "./core/model-runtime.ts";
export { DefaultResourceLoader, type ResourceLoader } from "./core/resource-loader.ts";
export { SessionManager } from "./core/session-manager.ts";
