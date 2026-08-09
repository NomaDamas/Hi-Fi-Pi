import { resolveNativeInputCapability } from "./native-input-capabilities.ts";
import type { Api, AttachmentRecord, Message, Model, NativeInputTransportSource, ProviderNativePart } from "./types.ts";

export type PortabilityClassification = "portable" | "reconstructable" | "provider-locked" | "missing" | "unsupported";

export interface PortabilityItem {
	id: string;
	kind: "attachment" | "provider-native" | "reasoning-state" | "provider-state" | "tool-state";
	classification: PortabilityClassification;
	reason: string;
	messageIndex: number;
	provider?: string;
	api?: Api;
	mediaType?: string;
	attachmentId?: string;
	stateId?: string;
}

export interface PortabilityReport {
	target: { provider: string; api: Api; modelId: string; baseUrl: string };
	items: PortabilityItem[];
	counts: Record<PortabilityClassification, number>;
	canSwitchWithoutLoss: boolean;
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
						kind: "attachment",
						classification: "missing",
						reason: `${attachment.filename} source is unavailable`,
						messageIndex,
						attachmentId: attachment.id,
						mediaType: attachment.mediaType,
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
						kind: "attachment",
						classification: "provider-locked",
						reason: `${attachment.filename} source belongs to ${attachment.source.provider ?? "another"}/${attachment.source.api ?? "transport"}/${attachment.source.endpoint ?? "endpoint"}`,
						messageIndex,
						attachmentId: attachment.id,
						mediaType: attachment.mediaType,
					});
					continue;
				}
				const capability = resolveNativeInputCapability(options.target, attachment.mediaType, source);
				const reconstructable = attachment.source.type === "path" || attachment.source.type === "base64";
				items.push({
					id: `message:${messageIndex}:attachment:${attachment.id}`,
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
				});
			}
		}

		for (const part of message.nativeParts ?? []) {
			const classification = classifyNativePart(part, options.target);
			items.push({
				id: `message:${messageIndex}:native:${part.stateId ?? part.kind}`,
				kind: "provider-native",
				messageIndex,
				provider: part.provider,
				api: part.api,
				stateId: part.stateId,
				...classification,
			});
		}

		if (message.role === "assistant") {
			for (const [index, state] of (message.reasoningState ?? []).entries()) {
				const isSame = sameBackend(state.provider, state.api, state.modelId, options.target);
				items.push({
					id: `message:${messageIndex}:reasoning:${index}`,
					kind: "reasoning-state",
					classification: isSame ? "portable" : "provider-locked",
					reason: isSame
						? "opaque reasoning state remains on its owning backend"
						: "opaque reasoning state is backend-locked",
					messageIndex,
					provider: state.provider,
					api: state.api,
				});
			}
			if (message.providerState) {
				const state = message.providerState;
				const isSame = sameBackend(state.provider, state.api, state.modelId, options.target);
				items.push({
					id: `message:${messageIndex}:provider-state`,
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
					kind: "tool-state",
					classification: isSame ? "portable" : "provider-locked",
					reason: isSame ? "tool metadata remains on its owning backend" : "tool metadata is backend-locked",
					messageIndex,
					provider: message.provider,
					api: message.api,
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
