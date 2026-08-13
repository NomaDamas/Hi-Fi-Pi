import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AttachmentRecord,
	AttachmentSource,
	PortabilityReport,
	ProviderTraceEvent,
} from "@earendil-works/pi-ai";
import { getNativeInputCapabilityManifest, type Model, sanitizeProviderTraceValue } from "@earendil-works/pi-ai";
import type { AgentDefinition, AgentDefinitionRegistry, CreatedDefinedAgent } from "../agent-definition.ts";
import type { AgentSessionEvent } from "../core/agent-session.ts";
import type { HeadlessAgentHost } from "../headless.ts";
import type { ProductAttachmentOwner, ProductAttachmentRequestContext, ProductPolicyEnforcer } from "./policy.ts";
import { type ProductIdentity, type ProductStorage, validateProductIdentity } from "./storage.ts";

export type ProductAgentAction =
	| "create_session"
	| "resume_session"
	| "prompt"
	| "upload_attachment"
	| "register_remote_attachment"
	| "subscribe"
	| "abort"
	| "inspect"
	| "close_session";

export interface ProductAuthorizationRequest {
	action: ProductAgentAction;
	identity: ProductIdentity;
	attachmentId?: string;
}

export interface ProductAgentAuthorizer {
	authorize(request: ProductAuthorizationRequest): boolean | Promise<boolean>;
}

export type ProductAgentEventKind =
	| "session_started"
	| "input_accepted"
	| "attachment_ready"
	| "assistant_text"
	| "reasoning"
	| "assistant_message"
	| "tool_call"
	| "tool_result"
	| "usage"
	| "provider_trace"
	| "run_end"
	| "done"
	| "error";

export interface ProductAgentEvent {
	sequence: number;
	timestamp: number;
	kind: ProductAgentEventKind;
	identity: ProductIdentity;
	data: Record<string, unknown>;
}

export interface ProductSessionInfo {
	identity: ProductIdentity;
	agentDefinition: { id: string; version: string };
	sessionId: string;
	sessionFile?: string;
	model: { provider: string; id: string; api: Api };
	isStreaming: boolean;
}

export interface CreateProductSessionOptions {
	cwd: string;
	definitionVersion?: string;
	resumeRecent?: boolean;
	sessionFile?: string;
}

export interface ProductPromptInput {
	text: string;
	attachmentIds?: string[];
	/** Explicitly allow target-scoped omission if the run creates incompatible native context. */
	allowLossy?: boolean;
}

export interface ProductUploadInput {
	filename: string;
	mediaType: string;
	bytes: Uint8Array;
	id?: string;
}

export interface ProductRemoteAttachmentInput {
	filename: string;
	mediaType: string;
	source: Exclude<AttachmentSource, { type: "path" }>;
	id?: string;
	sizeBytes?: number;
	sha256?: string;
}

export interface ProductAgentServerOptions {
	storage: ProductStorage;
	policy: ProductPolicyEnforcer;
	authorizer: ProductAgentAuthorizer;
	/** Must return a registry whose ModelRuntime uses credentials scoped to this identity. */
	registryForIdentity(identity: ProductIdentity): AgentDefinitionRegistry | Promise<AgentDefinitionRegistry>;
	maximumEventHistory?: number;
	maximumSubscriberQueue?: number;
}

export class ProductAgentServerError extends Error {
	readonly code:
		| "authorization_denied"
		| "session_exists"
		| "session_not_found"
		| "model_unavailable"
		| "attachment_not_found"
		| "event_backpressure";

	constructor(code: ProductAgentServerError["code"], message: string) {
		super(`Product agent server ${code}: ${message}`);
		this.name = "ProductAgentServerError";
		this.code = code;
	}
}

interface ActiveProductSession {
	identity: ProductIdentity;
	registry: AgentDefinitionRegistry;
	definition: AgentDefinition;
	host: HeadlessAgentHost;
	unsubscribe: () => void;
	sequence: number;
	history: ProductAgentEvent[];
	streams: Set<ProductAgentEventStream>;
}

interface PendingNext {
	resolve: (value: IteratorResult<ProductAgentEvent>) => void;
	reject: (reason?: unknown) => void;
}

export class ProductAgentEventStream implements AsyncIterableIterator<ProductAgentEvent> {
	private readonly queue: ProductAgentEvent[] = [];
	private readonly pending: PendingNext[] = [];
	private readonly maximumQueue: number;
	private readonly onClose: () => void;
	private closed = false;
	private failure?: Error;

	constructor(maximumQueue: number, onClose: () => void) {
		this.maximumQueue = maximumQueue;
		this.onClose = onClose;
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<ProductAgentEvent> {
		return this;
	}

	next(): Promise<IteratorResult<ProductAgentEvent>> {
		const event = this.queue.shift();
		if (event) return Promise.resolve({ done: false, value: event });
		if (this.failure) return Promise.reject(this.failure);
		if (this.closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
	}

	return(): Promise<IteratorResult<ProductAgentEvent>> {
		this.close();
		return Promise.resolve({ done: true, value: undefined });
	}

	push(event: ProductAgentEvent): boolean {
		if (this.closed) return false;
		const waiter = this.pending.shift();
		if (waiter) {
			waiter.resolve({ done: false, value: structuredClone(event) });
			return true;
		}
		if (this.queue.length >= this.maximumQueue) {
			this.close(new ProductAgentServerError("event_backpressure", "subscriber queue limit exceeded"));
			return false;
		}
		this.queue.push(structuredClone(event));
		return true;
	}

	close(error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.failure = error;
		this.queue.length = 0;
		for (const waiter of this.pending.splice(0)) {
			if (error) waiter.reject(error);
			else waiter.resolve({ done: true, value: undefined });
		}
		this.onClose();
	}
}

function identityKey(identity: ProductIdentity): string {
	return `${identity.tenantId}/${identity.userId}/${identity.agentId}/${identity.threadId}`;
}

function attachmentEventData(attachment: AttachmentRecord): Record<string, unknown> {
	return {
		attachmentId: attachment.id,
		filename: attachment.filename,
		mediaType: attachment.mediaType,
		...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
		...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
	};
}

function safeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/gi, "[redacted credential]")
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\/(?:Users|home)\/[^\s:]+/g, "[redacted path]");
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("");
}

export class ProductAgentServer {
	private readonly storage: ProductStorage;
	private readonly policy: ProductPolicyEnforcer;
	private readonly authorizer: ProductAgentAuthorizer;
	private readonly registryForIdentity: ProductAgentServerOptions["registryForIdentity"];
	private readonly maximumEventHistory: number;
	private readonly maximumSubscriberQueue: number;
	private readonly sessions = new Map<string, ActiveProductSession>();

	constructor(options: ProductAgentServerOptions) {
		this.storage = options.storage;
		this.policy = options.policy;
		this.authorizer = options.authorizer;
		this.registryForIdentity = options.registryForIdentity;
		this.maximumEventHistory = options.maximumEventHistory ?? 512;
		this.maximumSubscriberQueue = options.maximumSubscriberQueue ?? 128;
		if (this.maximumEventHistory < 1 || this.maximumSubscriberQueue < 1) {
			throw new ProductAgentServerError("event_backpressure", "event limits must be positive");
		}
	}

	async createSession(
		identityInput: ProductIdentity,
		options: CreateProductSessionOptions,
	): Promise<ProductSessionInfo> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, options.sessionFile || options.resumeRecent ? "resume_session" : "create_session");
		const key = identityKey(identity);
		if (this.sessions.has(key)) {
			throw new ProductAgentServerError("session_exists", `session is already active for ${key}`);
		}
		const manager = options.sessionFile
			? this.storage.openSessionManager(identity, options.sessionFile, options.cwd)
			: this.storage.createSessionManager(identity, options.cwd, { resumeRecent: options.resumeRecent });
		const registry = await this.registryForIdentity(structuredClone(identity));
		const created: CreatedDefinedAgent = await registry.create({
			agentId: identity.agentId,
			version: options.definitionVersion,
			cwd: options.cwd,
			threadId: identity.threadId,
			sessionManager: manager,
			productIdentity: identity,
		});
		const active: ActiveProductSession = {
			identity,
			registry,
			definition: created.definition,
			host: created.host,
			unsubscribe: () => {},
			sequence: 0,
			history: [],
			streams: new Set(),
		};
		active.unsubscribe = created.host.subscribe((event) => this.onSessionEvent(active, event));
		this.sessions.set(key, active);
		this.emit(active, "session_started", {
			sessionId: created.host.session.sessionId,
			agentId: created.definition.id,
			definitionVersion: created.definition.version,
		});
		return this.sessionInfo(active);
	}

	async uploadAttachment(identityInput: ProductIdentity, input: ProductUploadInput): Promise<AttachmentRecord> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, "upload_attachment", input.id);
		const attachment = this.storage.storeAttachment(identity, input);
		try {
			this.policy.assertAttachments(identity, [{ identity, record: attachment }], this.requestContext(identity));
		} catch (error) {
			this.storage.deleteAttachment(identity, attachment.id);
			throw error;
		}
		const active = this.sessions.get(identityKey(identity));
		if (active) this.emit(active, "attachment_ready", attachmentEventData(attachment));
		return attachment;
	}

	async registerRemoteAttachment(
		identityInput: ProductIdentity,
		input: ProductRemoteAttachmentInput,
	): Promise<AttachmentRecord> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, "register_remote_attachment", input.id);
		const attachment = this.storage.registerAttachment(identity, input);
		try {
			this.policy.assertAttachments(identity, [{ identity, record: attachment }], this.requestContext(identity));
		} catch (error) {
			this.storage.deleteAttachment(identity, attachment.id);
			throw error;
		}
		const active = this.sessions.get(identityKey(identity));
		if (active) this.emit(active, "attachment_ready", attachmentEventData(attachment));
		return attachment;
	}

	async prompt(identityInput: ProductIdentity, input: ProductPromptInput): Promise<void> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, "prompt");
		const active = this.requireSession(identity);
		const attachments: AttachmentRecord[] = [];
		for (const attachmentId of input.attachmentIds ?? []) {
			await this.authorize(identity, "prompt", attachmentId);
			const record = this.storage.getAttachment(identity, attachmentId);
			if (!record) {
				throw new ProductAgentServerError("attachment_not_found", `unknown attachment ${attachmentId}`);
			}
			attachments.push(record);
		}
		const owners: ProductAttachmentOwner[] = attachments.map((record) => ({ identity, record }));
		this.policy.assertAttachments(identity, owners, this.requestContext(identity));
		for (const attachment of attachments) this.emit(active, "attachment_ready", attachmentEventData(attachment));
		try {
			await active.host.prompt(
				{ text: input.text, attachments },
				{
					allowLossy: input.allowLossy,
					preflightResult: (success) => {
						if (success) {
							this.emit(active, "input_accepted", {
								attachmentIds: attachments.map((attachment) => attachment.id),
							});
						}
					},
				},
			);
		} catch (error) {
			this.emit(active, "error", { message: safeErrorMessage(error) });
			throw error;
		}
	}

	async events(
		identityInput: ProductIdentity,
		options: { afterSequence?: number } = {},
	): Promise<ProductAgentEventStream> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, "subscribe");
		const active = this.requireSession(identity);
		let stream: ProductAgentEventStream;
		stream = new ProductAgentEventStream(this.maximumSubscriberQueue, () => active.streams.delete(stream));
		active.streams.add(stream);
		for (const event of active.history) {
			if (event.sequence > (options.afterSequence ?? -1) && !stream.push(event)) break;
		}
		return stream;
	}

	async abort(identityInput: ProductIdentity): Promise<void> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, "abort");
		await this.requireSession(identity).host.abort();
	}

	async inspectCapabilities(
		identityInput: ProductIdentity,
	): Promise<ReturnType<typeof getNativeInputCapabilityManifest>> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, "inspect");
		const model = this.requireModel(this.requireSession(identity));
		return getNativeInputCapabilityManifest(model);
	}

	async inspectPortability(
		identityInput: ProductIdentity,
		target: { provider: string; modelId: string },
	): Promise<PortabilityReport> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, "inspect");
		const active = this.requireSession(identity);
		const targetModel = active.registry.modelRuntime.getModel(target.provider, target.modelId);
		if (!targetModel) {
			throw new ProductAgentServerError("model_unavailable", `unknown target ${target.provider}/${target.modelId}`);
		}
		return active.host.session.getPortabilityReport(targetModel);
	}

	async inspectTrace(identityInput: ProductIdentity): Promise<ProviderTraceEvent[]> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, "inspect");
		return this.requireSession(identity)
			.host.session.getProviderTraceEvents()
			.map((event) => sanitizeProviderTraceValue(event) as ProviderTraceEvent);
	}

	async getSession(identityInput: ProductIdentity): Promise<ProductSessionInfo> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, "inspect");
		return this.sessionInfo(this.requireSession(identity));
	}

	async closeSession(identityInput: ProductIdentity): Promise<void> {
		const identity = validateProductIdentity(identityInput);
		await this.authorize(identity, "close_session");
		const key = identityKey(identity);
		const active = this.requireSession(identity);
		this.sessions.delete(key);
		active.unsubscribe();
		for (const stream of active.streams) stream.close();
		await active.host.dispose();
	}

	async dispose(): Promise<void> {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		for (const active of sessions) {
			active.unsubscribe();
			for (const stream of active.streams) stream.close();
			await active.host.dispose();
		}
	}

	private async authorize(
		identity: ProductIdentity,
		action: ProductAgentAction,
		attachmentId?: string,
	): Promise<void> {
		const allowed = await this.authorizer.authorize({ action, identity: structuredClone(identity), attachmentId });
		if (!allowed) throw new ProductAgentServerError("authorization_denied", `${action} was not authorized`);
	}

	private requireSession(identity: ProductIdentity): ActiveProductSession {
		const active = this.sessions.get(identityKey(identity));
		if (!active) throw new ProductAgentServerError("session_not_found", "no active session for identity");
		return active;
	}

	private requireModel(active: ActiveProductSession): Model<Api> {
		const model = active.host.session.model;
		if (!model) throw new ProductAgentServerError("model_unavailable", "session has no selected model");
		return model;
	}

	private requestContext(identity: ProductIdentity): ProductAttachmentRequestContext {
		const model = this.requireModel(this.requireSession(identity));
		return { provider: model.provider, api: model.api, baseUrl: model.baseUrl };
	}

	private sessionInfo(active: ActiveProductSession): ProductSessionInfo {
		const model = this.requireModel(active);
		return {
			identity: structuredClone(active.identity),
			agentDefinition: { id: active.definition.id, version: active.definition.version },
			sessionId: active.host.session.sessionId,
			...(active.host.session.sessionFile ? { sessionFile: active.host.session.sessionFile } : {}),
			model: { provider: model.provider, id: model.id, api: model.api },
			isStreaming: active.host.session.isStreaming,
		};
	}

	private emit(active: ActiveProductSession, kind: ProductAgentEventKind, data: Record<string, unknown>): void {
		const event: ProductAgentEvent = {
			sequence: active.sequence,
			timestamp: Date.now(),
			kind,
			identity: structuredClone(active.identity),
			data: sanitizeProviderTraceValue(data) as Record<string, unknown>,
		};
		active.sequence += 1;
		active.history.push(event);
		if (active.history.length > this.maximumEventHistory) {
			active.history.splice(0, active.history.length - this.maximumEventHistory);
		}
		for (const stream of [...active.streams]) {
			if (!stream.push(event)) active.streams.delete(stream);
		}
	}

	private onSessionEvent(active: ActiveProductSession, event: AgentSessionEvent): void {
		if (event.type === "provider_trace") {
			this.emit(active, "provider_trace", event as unknown as Record<string, unknown>);
			return;
		}
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") this.emit(active, "assistant_text", { delta: update.delta });
			else if (update.type === "thinking_delta") this.emit(active, "reasoning", { delta: update.delta });
			else if (update.type === "toolcall_end") {
				this.emit(active, "tool_call", {
					toolCallId: update.toolCall.id,
					toolName: update.toolCall.name,
					state: "prepared",
				});
			} else if (update.type === "error") {
				this.emit(active, "error", { message: safeErrorMessage(update.error.errorMessage ?? update.reason) });
			}
			return;
		}
		if (event.type === "message_end") {
			if (event.message.role === "assistant") {
				this.emit(active, "assistant_message", {
					text: assistantText(event.message),
					stopReason: event.message.stopReason,
					provider: event.message.provider,
					model: event.message.model,
				});
				this.emit(active, "usage", { ...event.message.usage });
			} else if (event.message.role === "toolResult") {
				this.emit(active, "tool_result", {
					toolCallId: event.message.toolCallId,
					toolName: event.message.toolName,
					isError: event.message.isError,
				});
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			this.emit(active, "tool_call", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				state: "started",
			});
			return;
		}
		if (event.type === "tool_execution_end") {
			this.emit(active, "tool_result", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
			});
			return;
		}
		if (event.type === "agent_end") {
			this.emit(active, "run_end", { willRetry: event.willRetry });
			return;
		}
		if (event.type === "agent_settled" && !active.host.session.getPendingPortabilityConfirmation()) {
			this.emit(active, "done", {});
		}
	}
}
