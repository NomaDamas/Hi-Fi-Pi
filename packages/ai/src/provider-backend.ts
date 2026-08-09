import {
	type AttachmentDeleteContext,
	type AttachmentUploadContext,
	registerAttachmentUploadBackend,
} from "./attachment-lifecycle.ts";
import { getNativeInputCapabilityManifest } from "./native-input-capabilities.ts";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderConversationState,
	ProviderFileReference,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";

export const PROVIDER_BACKEND_API_VERSION = 1 as const;

export type ProviderBackendMatchValue = string | readonly string[] | RegExp;

export interface ProviderBackendMatch {
	provider?: ProviderBackendMatchValue;
	api?: ProviderBackendMatchValue;
	modelId?: ProviderBackendMatchValue;
	baseUrl?: ProviderBackendMatchValue;
	endpointProfile?: ProviderBackendMatchValue;
}

export interface ProviderBackendContext {
	model: Model<Api>;
	provider: string;
	api: Api;
	modelId: string;
	baseUrl: string;
	endpointProfile?: string;
}

export interface ProviderBackendCapabilities {
	inputs?: Record<string, unknown>;
	outputs?: Record<string, unknown>;
	tools?: Record<string, unknown>;
	controls?: Record<string, unknown>;
	transports?: Record<string, unknown>;
}

export interface ProviderBackendPrepareContext extends ProviderBackendContext {
	conversation: Context;
	options?: StreamOptions;
	simple: boolean;
}

export interface PreparedProviderInput {
	conversation?: Context;
	options?: StreamOptions;
	request?: unknown;
	state?: unknown;
}

export interface ProviderBackendStreamContext extends ProviderBackendContext {
	conversation: Context;
	options?: StreamOptions;
	request?: unknown;
	state?: unknown;
	simple: boolean;
}

export interface ProviderBackendV1 {
	apiVersion: typeof PROVIDER_BACKEND_API_VERSION;
	id: string;
	priority?: number;
	match: ProviderBackendMatch;
	/** Explicitly allow matching endpoints not named in match.baseUrl or match.endpointProfile. */
	allowCustomEndpoints?: boolean;
	matches?: (context: ProviderBackendContext) => boolean;
	resolveCapabilities?: (
		context: ProviderBackendContext,
	) => ProviderBackendCapabilities | Promise<ProviderBackendCapabilities>;
	prepareInput?: (context: ProviderBackendPrepareContext) => PreparedProviderInput | Promise<PreparedProviderInput>;
	stream: (
		context: ProviderBackendStreamContext,
	) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	parseResponse?: (response: unknown, context: ProviderBackendContext) => unknown | Promise<unknown>;
	uploadAttachment?: (context: AttachmentUploadContext) => Promise<ProviderFileReference>;
	deleteRemoteFile?: (context: AttachmentDeleteContext) => Promise<void>;
	restoreState?: (state: ProviderConversationState, context: ProviderBackendContext) => void | Promise<void>;
}

export type ProviderBackendRegistration = Omit<ProviderBackendV1, "apiVersion"> & { apiVersion: number };

export interface ProviderBackendCandidateDiagnostic {
	id: string;
	priority: number;
	specificity: number;
	matched: boolean;
	reason?: string;
}

export interface ProviderBackendSelection {
	kind: "registered" | "legacy";
	id: string;
	context: ProviderBackendContext;
	backend?: ProviderBackendV1;
	candidates: ProviderBackendCandidateDiagnostic[];
}

export class ProviderBackendVersionError extends Error {
	constructor(id: string, version: number) {
		super(`Provider backend ${id} uses API version ${version}; expected ${PROVIDER_BACKEND_API_VERSION}`);
		this.name = "ProviderBackendVersionError";
	}
}

export class AmbiguousProviderBackendError extends Error {
	readonly context: ProviderBackendContext;
	readonly backendIds: string[];

	constructor(context: ProviderBackendContext, backendIds: string[]) {
		super(
			`Ambiguous provider backends for ${context.provider}/${context.api}/${context.modelId} (${context.baseUrl}): ${backendIds.join(", ")}`,
		);
		this.name = "AmbiguousProviderBackendError";
		this.context = context;
		this.backendIds = backendIds;
	}
}

export class ProviderBackendExecutionError extends Error {
	readonly backendId: string;
	readonly context: ProviderBackendContext;

	constructor(backendId: string, context: ProviderBackendContext, operation: string, cause: unknown) {
		super(
			`Provider backend ${backendId} failed during ${operation} for ${context.provider}/${context.api}/${context.modelId}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "ProviderBackendExecutionError";
		this.backendId = backendId;
		this.context = context;
	}
}

const registeredBackends = new Map<string, ProviderBackendV1>();

function canonicalBaseUrl(value: string): string {
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		url.pathname = url.pathname.replace(/\/+$/, "");
		return url.toString().replace(/\/$/, "");
	} catch {
		return value.replace(/\?.*$/, "").replace(/\/+$/, "");
	}
}

export function getProviderBackendContext(model: Model<Api>): ProviderBackendContext {
	const endpointProfile = getNativeInputCapabilityManifest(model)?.endpointProfile;
	return {
		model,
		provider: model.provider,
		api: model.api,
		modelId: model.id,
		baseUrl: canonicalBaseUrl(model.baseUrl),
		...(endpointProfile ? { endpointProfile } : {}),
	};
}

function matchesValue(actual: string | undefined, expected: ProviderBackendMatchValue | undefined): boolean {
	if (expected === undefined) return true;
	if (actual === undefined) return false;
	if (typeof expected === "string") return actual === expected;
	if (expected instanceof RegExp) return new RegExp(expected.source, expected.flags.replace(/[gy]/g, "")).test(actual);
	return expected.includes(actual);
}

function specificity(match: ProviderBackendMatch): number {
	return Object.values(match).filter((value) => value !== undefined).length;
}

function evaluateBackend(
	backend: ProviderBackendV1,
	context: ProviderBackendContext,
): ProviderBackendCandidateDiagnostic {
	const endpointOptIn =
		backend.allowCustomEndpoints === true ||
		backend.match.baseUrl !== undefined ||
		backend.match.endpointProfile !== undefined;
	if (!endpointOptIn) {
		return {
			id: backend.id,
			priority: backend.priority ?? 0,
			specificity: specificity(backend.match),
			matched: false,
			reason: "backend must opt into endpoints with match.baseUrl, match.endpointProfile or allowCustomEndpoints",
		};
	}
	const declarativeMatch =
		matchesValue(context.provider, backend.match.provider) &&
		matchesValue(context.api, backend.match.api) &&
		matchesValue(context.modelId, backend.match.modelId) &&
		matchesValue(context.baseUrl, backend.match.baseUrl) &&
		matchesValue(context.endpointProfile, backend.match.endpointProfile);
	let callbackMatch = declarativeMatch;
	if (declarativeMatch && backend.matches) {
		try {
			callbackMatch = backend.matches(context);
		} catch (error) {
			throw new ProviderBackendExecutionError(backend.id, context, "matching", error);
		}
	}
	return {
		id: backend.id,
		priority: backend.priority ?? 0,
		specificity: specificity(backend.match),
		matched: callbackMatch,
		...(!declarativeMatch ? { reason: "declarative match did not match" } : {}),
	};
}

function selectRegisteredBackend(context: ProviderBackendContext): {
	backend?: ProviderBackendV1;
	candidates: ProviderBackendCandidateDiagnostic[];
} {
	const candidates = [...registeredBackends.values()]
		.map((backend) => evaluateBackend(backend, context))
		.sort((left, right) => left.id.localeCompare(right.id));
	const matches = candidates
		.filter((candidate) => candidate.matched)
		.sort(
			(left, right) =>
				right.priority - left.priority || right.specificity - left.specificity || left.id.localeCompare(right.id),
		);
	const best = matches[0];
	if (!best) return { candidates };
	const tied = matches.filter(
		(candidate) => candidate.priority === best.priority && candidate.specificity === best.specificity,
	);
	if (tied.length > 1)
		throw new AmbiguousProviderBackendError(
			context,
			tied.map((candidate) => candidate.id),
		);
	return { backend: registeredBackends.get(best.id), candidates };
}

export function inspectProviderBackendSelection(model: Model<Api>): ProviderBackendSelection {
	const context = getProviderBackendContext(model);
	const { backend, candidates } = selectRegisteredBackend(context);
	return backend
		? { kind: "registered", id: backend.id, context, backend, candidates }
		: {
				kind: "legacy",
				id: `legacy:${context.provider}/${context.api}`,
				context,
				candidates,
			};
}

export function listProviderBackends(): readonly ProviderBackendV1[] {
	return [...registeredBackends.values()];
}

export function registerProviderBackend(registration: ProviderBackendRegistration): () => void {
	if (registration.apiVersion !== PROVIDER_BACKEND_API_VERSION) {
		throw new ProviderBackendVersionError(registration.id, registration.apiVersion);
	}
	if (registeredBackends.has(registration.id))
		throw new Error(`Provider backend already registered: ${registration.id}`);
	const backend = registration as ProviderBackendV1;
	registeredBackends.set(backend.id, backend);
	const unregisterUpload = backend.uploadAttachment
		? registerAttachmentUploadBackend({
				apiVersion: 1,
				id: `provider-backend:${backend.id}`,
				matches: (model) => inspectProviderBackendSelection(model).backend?.id === backend.id,
				upload: backend.uploadAttachment,
				...(backend.deleteRemoteFile ? { delete: backend.deleteRemoteFile } : {}),
			})
		: undefined;
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		if (registeredBackends.get(backend.id) === backend) registeredBackends.delete(backend.id);
		unregisterUpload?.();
	};
}

export interface DispatchProviderBackendOptions {
	model: Model<Api>;
	conversation: Context;
	options?: StreamOptions | SimpleStreamOptions;
	simple: boolean;
	legacy: (conversation: Context, options?: StreamOptions) => AssistantMessageEventStream;
}

export async function dispatchProviderBackend(
	input: DispatchProviderBackendOptions,
): Promise<AssistantMessageEventStream> {
	const selection = inspectProviderBackendSelection(input.model);
	if (!selection.backend) return input.legacy(input.conversation, input.options);
	const backend = selection.backend;
	try {
		for (const message of input.conversation.messages) {
			if (
				message.role !== "assistant" ||
				!message.providerState ||
				!backend.restoreState ||
				message.providerState.provider !== selection.context.provider ||
				(message.providerState.api !== undefined && message.providerState.api !== selection.context.api)
			)
				continue;
			await backend.restoreState(message.providerState, selection.context);
		}
		const prepared = backend.prepareInput
			? await backend.prepareInput({
					...selection.context,
					conversation: input.conversation,
					options: input.options,
					simple: input.simple,
				})
			: {};
		return await backend.stream({
			...selection.context,
			conversation: prepared.conversation ?? input.conversation,
			options: prepared.options ?? input.options,
			request: prepared.request,
			state: prepared.state,
			simple: input.simple,
		});
	} catch (error) {
		throw new ProviderBackendExecutionError(backend.id, selection.context, "request", error);
	}
}
