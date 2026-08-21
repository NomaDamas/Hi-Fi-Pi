import { resolveNativeInputCapability } from "./native-input-capabilities.ts";
import type { Api, AttachmentRecord, Message, Model, NativeInputTransportSource, ProviderNativePart } from "./types.ts";

export type PortabilityClassification = "portable" | "reconstructable" | "provider-locked" | "missing" | "unsupported";

export interface PortabilityItem {
	id: string;
	/** Stable identity used to persist an explicit loss decision across context reconstruction. */
	stableId: string;
	/** False when this item has no canonical identity and therefore cannot be approved for omission. */
	projectable: boolean;
	kind: "attachment" | "provider-native" | "reasoning-state" | "provider-state" | "tool-state";
	classification: PortabilityClassification;
	reason: string;
	messageIndex: number;
	provider?: string;
	api?: Api;
	mediaType?: string;
	filename?: string;
	attachmentId?: string;
	stateId?: string;
	partIndex?: number;
}

export interface PortabilityTarget {
	provider: string;
	api: Api;
	modelId: string;
	baseUrl: string;
}

export interface PortabilityReport {
	target: PortabilityTarget;
	items: PortabilityItem[];
	counts: Record<PortabilityClassification, number>;
	canSwitchWithoutLoss: boolean;
}

export interface ConversationProjection {
	messages: Message[];
	target: PortabilityTarget;
	report: PortabilityReport;
	activeAttachmentIds: string[];
	suspendedAttachmentIds: string[];
	suspendedItemIds: string[];
	unapprovedItemIds: string[];
}

export interface ConversationProjectionOptions extends PortabilityAnalysisOptions {
	approvedItemIds?: Iterable<string>;
}

export interface PortabilityAnalysisOptions {
	messages: readonly Message[];
	attachments?: Iterable<AttachmentRecord>;
	target: Pick<Model<Api>, "provider" | "api" | "id" | "baseUrl" | "nativeAttachments" | "nativeInputs">;
	sourceAvailable?: (attachment: AttachmentRecord) => boolean;
}

function transportSource(attachment: AttachmentRecord): NativeInputTransportSource {
	if (attachment.source.type === "path" || attachment.source.type === "base64") return "inline";
	return attachment.source.type;
}

function sameBackend(
	provider: string,
	api: Api | undefined,
	modelId: string | undefined,
	target: PortabilityAnalysisOptions["target"],
): boolean {
	return provider === target.provider && (!api || api === target.api) && (!modelId || modelId === target.id);
}

function normalizeEndpoint(value: string): string {
	return value.replace(/\/+$/, "");
}

function endpointIdentity(value: string): string {
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return normalizeEndpoint(url.toString());
	} catch {
		return normalizeEndpoint(value.split("?")[0] ?? value);
	}
}

export function getPortabilityTargetKey(target: PortabilityTarget): string {
	return [target.provider, target.api, target.modelId, endpointIdentity(target.baseUrl)].join("\0");
}

function messageStableScope(message: Message): string | undefined {
	if (message.role === "toolResult") return `tool-result:${message.toolCallId}`;
	if (message.role !== "assistant") return undefined;
	if (message.responseId) return `assistant-response:${message.provider}:${message.responseId}`;
	const state = message.providerState;
	const stateId = state?.responseId ?? state?.continuationId ?? state?.cachedContentId;
	return state && stateId ? `assistant-state:${state.provider}:${stateId}` : undefined;
}

function nativePartStableIdentity(
	message: Message,
	part: ProviderNativePart,
	partIndex: number,
): { stableId: string; projectable: boolean } {
	if (part.stateId) {
		return {
			stableId: `provider-native:${part.provider}:${part.api ?? ""}:${part.modelId ?? ""}:${part.kind}:${part.stateId}`,
			projectable: true,
		};
	}
	const scope = messageStableScope(message);
	return {
		stableId: scope
			? `provider-native:${scope}:${part.provider}:${part.api ?? ""}:${part.modelId ?? ""}:${part.kind}:${partIndex}`
			: `unprojectable:provider-native:${part.provider}:${part.kind}:${partIndex}`,
		projectable: scope !== undefined,
	};
}

function classifyNativePart(
	part: ProviderNativePart,
	target: PortabilityAnalysisOptions["target"],
): { classification: PortabilityClassification; reason: string } {
	if (part.portability === "portable") {
		return { classification: "portable", reason: `${part.kind} declares portable semantics` };
	}
	if (sameBackend(part.provider, part.api, part.modelId, target)) {
		return { classification: "portable", reason: `${part.kind} remains on its owning backend` };
	}
	if (part.portability === "reconstructable") {
		return { classification: "reconstructable", reason: `${part.kind} can be reconstructed for the target` };
	}
	return {
		classification: "provider-locked",
		reason: `${part.kind} belongs to ${part.provider}/${part.api ?? "any transport"}/${part.modelId ?? "any model"}`,
	};
}

export function analyzeConversationPortability(options: PortabilityAnalysisOptions): PortabilityReport {
	const attachments = new Map(Array.from(options.attachments ?? [], (attachment) => [attachment.id, attachment]));
	const items: PortabilityItem[] = [];
	for (let messageIndex = 0; messageIndex < options.messages.length; messageIndex += 1) {
		const message = options.messages[messageIndex];
		if (!message) continue;
		if (message.role === "user" || message.role === "toolResult") {
			for (const reference of message.attachments ?? []) {
				const attachment = attachments.get(reference.attachmentId);
				if (!attachment) {
					items.push({
						id: `message:${messageIndex}:attachment:${reference.attachmentId}`,
						stableId: `attachment:${reference.attachmentId}`,
						projectable: true,
						kind: "attachment",
						classification: "missing",
						reason: `attachment ${reference.attachmentId} is not present in the registry`,
						messageIndex,
						attachmentId: reference.attachmentId,
					});
					continue;
				}
				if (options.sourceAvailable && !options.sourceAvailable(attachment)) {
					items.push({
						id: `message:${messageIndex}:attachment:${attachment.id}`,
						stableId: `attachment:${attachment.id}`,
						projectable: true,
						kind: "attachment",
						classification: "missing",
						reason: `${attachment.filename} source is unavailable`,
						messageIndex,
						attachmentId: attachment.id,
						mediaType: attachment.mediaType,
						filename: attachment.filename,
					});
					continue;
				}
				const source = transportSource(attachment);
				if (
					(attachment.source.type === "provider-file" || attachment.source.type === "cloud-uri") &&
					((attachment.source.provider && attachment.source.provider !== options.target.provider) ||
						(attachment.source.api && attachment.source.api !== options.target.api) ||
						(attachment.source.endpoint &&
							endpointIdentity(attachment.source.endpoint) !== endpointIdentity(options.target.baseUrl)))
				) {
					items.push({
						id: `message:${messageIndex}:attachment:${attachment.id}`,
						stableId: `attachment:${attachment.id}`,
						projectable: true,
						kind: "attachment",
						classification: "provider-locked",
						reason: `${attachment.filename} source belongs to ${attachment.source.provider ?? "another"}/${attachment.source.api ?? "transport"}/${attachment.source.endpoint ? endpointIdentity(attachment.source.endpoint) : "endpoint"}`,
						messageIndex,
						attachmentId: attachment.id,
						mediaType: attachment.mediaType,
						filename: attachment.filename,
					});
					continue;
				}
				const capability = resolveNativeInputCapability(options.target, attachment.mediaType, source);
				const reconstructable = attachment.source.type === "path" || attachment.source.type === "base64";
				items.push({
					id: `message:${messageIndex}:attachment:${attachment.id}`,
					stableId: `attachment:${attachment.id}`,
					projectable: true,
					kind: "attachment",
					classification: capability.supported
						? reconstructable
							? "reconstructable"
							: "portable"
						: "unsupported",
					reason: capability.supported
						? reconstructable
							? `${attachment.filename} can be lowered or uploaded for ${options.target.provider}`
							: `${attachment.filename} source is accepted by the target`
						: (capability.reason ?? `${attachment.mediaType} is unsupported by the target`),
					messageIndex,
					attachmentId: attachment.id,
					mediaType: attachment.mediaType,
					filename: attachment.filename,
				});
			}
		}

		for (const [partIndex, part] of (message.nativeParts ?? []).entries()) {
			const classification = classifyNativePart(part, options.target);
			const identity = nativePartStableIdentity(message, part, partIndex);
			items.push({
				id: `message:${messageIndex}:native:${part.stateId ?? part.kind}`,
				...identity,
				kind: "provider-native",
				messageIndex,
				partIndex,
				provider: part.provider,
				api: part.api,
				stateId: part.stateId,
				...classification,
			});
		}

		if (message.role === "assistant") {
			const messageScope = messageStableScope(message);
			for (const [index, state] of (message.reasoningState ?? []).entries()) {
				const isSame = sameBackend(state.provider, state.api, state.modelId, options.target);
				items.push({
					id: `message:${messageIndex}:reasoning:${index}`,
					stableId: messageScope
						? `reasoning:${messageScope}:${state.provider}:${state.api ?? ""}:${state.modelId ?? ""}:${index}`
						: `unprojectable:reasoning:${state.provider}:${index}`,
					projectable: messageScope !== undefined,
					kind: "reasoning-state",
					classification: isSame ? "portable" : "provider-locked",
					reason: isSame
						? "opaque reasoning state remains on its owning backend"
						: "opaque reasoning state is backend-locked",
					messageIndex,
					provider: state.provider,
					api: state.api,
					partIndex: index,
				});
			}
			if (message.providerState) {
				const state = message.providerState;
				const isSame = sameBackend(state.provider, state.api, state.modelId, options.target);
				const stateId = state.responseId ?? state.continuationId ?? state.cachedContentId;
				items.push({
					id: `message:${messageIndex}:provider-state`,
					stableId: stateId
						? `provider-state:${state.provider}:${state.api ?? ""}:${state.modelId ?? ""}:${stateId}`
						: `unprojectable:provider-state:${state.provider}`,
					projectable: stateId !== undefined,
					kind: "provider-state",
					classification: isSame ? "portable" : "provider-locked",
					reason: isSame
						? "provider conversation state remains valid"
						: "provider conversation state cannot cross backends",
					messageIndex,
					provider: state.provider,
					api: state.api,
				});
			}
			for (const [index, toolCall] of message.content.entries()) {
				if (toolCall.type !== "toolCall" || !toolCall.providerMetadata) continue;
				const isSame = message.provider === options.target.provider && message.api === options.target.api;
				items.push({
					id: `message:${messageIndex}:tool:${index}`,
					stableId: `tool-state:${message.provider}:${message.api}:${toolCall.id}`,
					projectable: true,
					kind: "tool-state",
					classification: isSame ? "portable" : "provider-locked",
					reason: isSame ? "tool metadata remains on its owning backend" : "tool metadata is backend-locked",
					messageIndex,
					provider: message.provider,
					api: message.api,
					partIndex: index,
				});
			}
		}
	}

	const counts: Record<PortabilityClassification, number> = {
		portable: 0,
		reconstructable: 0,
		"provider-locked": 0,
		missing: 0,
		unsupported: 0,
	};
	for (const item of items) counts[item.classification] += 1;
	return {
		target: {
			provider: options.target.provider,
			api: options.target.api,
			modelId: options.target.id,
			baseUrl: endpointIdentity(options.target.baseUrl),
		},
		items,
		counts,
		canSwitchWithoutLoss: counts["provider-locked"] === 0 && counts.missing === 0 && counts.unsupported === 0,
	};
}

function isLossyItem(item: PortabilityItem): boolean {
	return (
		item.classification === "provider-locked" ||
		item.classification === "missing" ||
		item.classification === "unsupported"
	);
}

function unique(values: Iterable<string>): string[] {
	return Array.from(new Set(values));
}

function attachmentOmissionPlaceholder(items: readonly PortabilityItem[]): string {
	const uniqueItems = new Map(items.map((item) => [item.stableId, item]));
	return Array.from(uniqueItems.values(), (item) => {
		const mediaType = item.mediaType ?? "unknown media type";
		if (item.classification === "missing") {
			return `(${mediaType} attachment omitted: source is unavailable)`;
		}
		if (item.classification === "provider-locked") {
			return `(${mediaType} attachment omitted: source is bound to another provider transport)`;
		}
		return `(${mediaType} attachment omitted: target model does not support ${mediaType})`;
	}).join("\n");
}

/**
 * Materialize a target-specific conversation without mutating canonical messages.
 * Only incompatible items whose stable identities were explicitly approved are removed.
 */
export function projectConversationForTarget(options: ConversationProjectionOptions): ConversationProjection {
	const report = analyzeConversationPortability(options);
	const approvedItemIds = new Set(options.approvedItemIds ?? []);
	const suspendedItems = report.items.filter(
		(item) => isLossyItem(item) && item.projectable && approvedItemIds.has(item.stableId),
	);
	const unapprovedItems = report.items.filter(
		(item) => isLossyItem(item) && (!item.projectable || !approvedItemIds.has(item.stableId)),
	);
	const suspendedByMessage = new Map<number, PortabilityItem[]>();
	for (const item of suspendedItems) {
		const items = suspendedByMessage.get(item.messageIndex) ?? [];
		items.push(item);
		suspendedByMessage.set(item.messageIndex, items);
	}

	const messages = options.messages.map((message, messageIndex): Message => {
		const suspended = suspendedByMessage.get(messageIndex);
		if (!suspended?.length) return message;
		const attachmentIds = new Set(
			suspended.filter((item) => item.kind === "attachment").map((item) => item.attachmentId),
		);
		const suspendedAttachments = suspended.filter((item) => item.kind === "attachment");
		const nativePartIndexes = new Set(
			suspended.filter((item) => item.kind === "provider-native").map((item) => item.partIndex),
		);
		let projected: Message = message;

		if ((message.role === "user" || message.role === "toolResult") && attachmentIds.size > 0) {
			const attachments = message.attachments?.filter((reference) => !attachmentIds.has(reference.attachmentId));
			const placeholder = { type: "text" as const, text: attachmentOmissionPlaceholder(suspendedAttachments) };
			const content =
				message.role === "user" && typeof message.content === "string"
					? [...(message.content ? [{ type: "text" as const, text: message.content }] : []), placeholder]
					: [...message.content, placeholder];
			projected = {
				...projected,
				content,
				...(attachments?.length ? { attachments } : { attachments: undefined }),
			} as Message;
		}
		if (nativePartIndexes.size > 0) {
			const nativeParts = message.nativeParts?.filter((_part, index) => !nativePartIndexes.has(index));
			projected = {
				...projected,
				...(nativeParts?.length ? { nativeParts } : { nativeParts: undefined }),
			} as Message;
		}
		if (message.role === "assistant") {
			const reasoningIndexes = new Set(
				suspended.filter((item) => item.kind === "reasoning-state").map((item) => item.partIndex),
			);
			const toolIndexes = new Set(
				suspended.filter((item) => item.kind === "tool-state").map((item) => item.partIndex),
			);
			if (reasoningIndexes.size > 0) {
				const reasoningState = message.reasoningState?.filter((_state, index) => !reasoningIndexes.has(index));
				projected = {
					...projected,
					...(reasoningState?.length ? { reasoningState } : { reasoningState: undefined }),
				} as Message;
			}
			if (suspended.some((item) => item.kind === "provider-state")) {
				projected = { ...projected, providerState: undefined } as Message;
			}
			if (toolIndexes.size > 0) {
				projected = {
					...projected,
					content: message.content.map((content, index) => {
						if (content.type !== "toolCall" || !toolIndexes.has(index)) return content;
						const { providerMetadata: _providerMetadata, ...portableToolCall } = content;
						return portableToolCall;
					}),
				} as Message;
			}
		}
		return projected;
	});

	const suspendedStableIds = new Set(suspendedItems.map((item) => item.stableId));
	return {
		messages,
		target: report.target,
		report,
		activeAttachmentIds: unique(
			report.items
				.filter(
					(item) =>
						item.kind === "attachment" &&
						!suspendedStableIds.has(item.stableId) &&
						(item.classification === "portable" || item.classification === "reconstructable"),
				)
				.flatMap((item) => (item.attachmentId ? [item.attachmentId] : [])),
		),
		suspendedAttachmentIds: unique(
			suspendedItems.flatMap((item) => (item.kind === "attachment" && item.attachmentId ? [item.attachmentId] : [])),
		),
		suspendedItemIds: unique(suspendedItems.map((item) => item.stableId)),
		unapprovedItemIds: unique(unapprovedItems.map((item) => item.stableId)),
	};
}

export class PortabilityConfirmationRequiredError extends Error {
	readonly report: PortabilityReport;

	constructor(report: PortabilityReport) {
		super(
			`Model switch requires confirmation: ${report.counts["provider-locked"]} provider-locked, ${report.counts.missing} missing, ${report.counts.unsupported} unsupported item(s)`,
		);
		this.name = "PortabilityConfirmationRequiredError";
		this.report = report;
	}
}
