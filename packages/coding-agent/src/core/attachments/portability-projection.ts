import type { PortabilityReport } from "@earendil-works/pi-ai";
import {
	getPortabilityTargetKey,
	PortabilityConfirmationRequiredError,
	projectConversationForTarget,
} from "@earendil-works/pi-ai";
import type { AttachmentRecord, ConversationProjection, Message, Model } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "../session-manager.ts";

const DECISION_TYPE = "hifi.portability-decision";

interface PortabilityProjectionStore {
	getBranch(): SessionEntry[];
	appendCustomEntry(customType: string, data?: unknown): string;
}

export interface PortabilityProjectionCoordinatorOptions {
	store: PortabilityProjectionStore;
	listAttachments: () => readonly AttachmentRecord[];
	sourceAvailable: (attachment: AttachmentRecord) => boolean;
}

export interface StoredPortabilityDecision {
	version: 2;
	acceptedLoss: true;
	timestamp: number;
	targetKey: string;
	approvedItemIds: string[];
	report: PortabilityReport;
}

export interface AppliedPortabilityProjection extends ConversationProjection {
	decisionEntryId?: string;
}

export interface PortabilityPreflightOptions {
	allowLossy?: boolean;
	/** Persist newly approved IDs to the branch. Disable for one-run blanket opt-in. */
	persistApproval?: boolean;
	/** IDs disclosed and accepted by an interactive confirmation callback. */
	approvedItemIds?: Iterable<string>;
}

function isStoredDecision(value: unknown): value is StoredPortabilityDecision {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<StoredPortabilityDecision>;
	return (
		record.version === 2 &&
		record.acceptedLoss === true &&
		typeof record.timestamp === "number" &&
		typeof record.targetKey === "string" &&
		Array.isArray(record.approvedItemIds) &&
		record.approvedItemIds.every((item) => typeof item === "string") &&
		!!record.report &&
		typeof record.report === "object"
	);
}

function unapprovedReport(projection: ConversationProjection): PortabilityReport {
	const unapproved = new Set(projection.unapprovedItemIds);
	const items = projection.report.items.filter((item) => unapproved.has(item.stableId));
	const counts: PortabilityReport["counts"] = {
		portable: 0,
		reconstructable: 0,
		"provider-locked": 0,
		missing: 0,
		unsupported: 0,
	};
	for (const item of items) counts[item.classification] += 1;
	return { target: projection.target, items, counts, canSwitchWithoutLoss: false };
}

function unprojectableReport(projection: ConversationProjection): PortabilityReport {
	const items = projection.report.items.filter(
		(item) =>
			!item.projectable &&
			(item.classification === "provider-locked" ||
				item.classification === "missing" ||
				item.classification === "unsupported"),
	);
	const counts: PortabilityReport["counts"] = {
		portable: 0,
		reconstructable: 0,
		"provider-locked": 0,
		missing: 0,
		unsupported: 0,
	};
	for (const item of items) counts[item.classification] += 1;
	return { target: projection.target, items, counts, canSwitchWithoutLoss: false };
}

function hasLossyUnprojectableItem(projection: ConversationProjection): boolean {
	return projection.report.items.some(
		(item) =>
			!item.projectable &&
			(item.classification === "provider-locked" ||
				item.classification === "missing" ||
				item.classification === "unsupported"),
	);
}

/** Cheap structural guard for the attachment-free legacy path. */
export function hasPortabilityRelevantContent(messages: readonly Message[]): boolean {
	return messages.some((message) => {
		if ((message.role === "user" || message.role === "toolResult") && message.attachments?.length) return true;
		if (message.nativeParts?.length) return true;
		if (message.role !== "assistant") return false;
		if (message.reasoningState?.length || message.providerState) return true;
		return message.content.some((part) => part.type === "toolCall" && part.providerMetadata !== undefined);
	});
}

/** Owns branch-scoped loss decisions while leaving canonical messages untouched. */
export class PortabilityProjectionCoordinator {
	private readonly store: PortabilityProjectionStore;
	private readonly listAttachments: () => readonly AttachmentRecord[];
	private readonly sourceAvailable: (attachment: AttachmentRecord) => boolean;

	constructor(options: PortabilityProjectionCoordinatorOptions) {
		this.store = options.store;
		this.listAttachments = options.listAttachments;
		this.sourceAvailable = options.sourceAvailable;
	}

	hasDecision(target: Model<any>): boolean {
		return this.findDecision(target) !== undefined;
	}

	inspect(messages: readonly Message[], target: Model<any>): AppliedPortabilityProjection {
		const stored = this.findDecision(target);
		return {
			...projectConversationForTarget({
				messages,
				attachments: this.listAttachments(),
				target,
				sourceAvailable: this.sourceAvailable,
				approvedItemIds: stored?.decision.approvedItemIds,
			}),
			...(stored ? { decisionEntryId: stored.entryId } : {}),
		};
	}

	preflight(
		messages: readonly Message[],
		target: Model<any>,
		options: PortabilityPreflightOptions = {},
	): AppliedPortabilityProjection {
		const stored = this.findDecision(target);
		const approvedItemIds = new Set(stored?.decision.approvedItemIds ?? []);
		for (const itemId of options.approvedItemIds ?? []) approvedItemIds.add(itemId);
		let projection = this.project(messages, target, approvedItemIds);
		if (hasLossyUnprojectableItem(projection)) {
			throw new PortabilityProjectionUnavailableError(unprojectableReport(projection));
		}
		if (projection.unapprovedItemIds.length > 0) {
			if (!options.allowLossy) throw new PortabilityConfirmationRequiredError(unapprovedReport(projection));
			for (const itemId of projection.unapprovedItemIds) approvedItemIds.add(itemId);
			projection = this.project(messages, target, approvedItemIds);
		}
		if (projection.unapprovedItemIds.length > 0) {
			throw new PortabilityProjectionUnavailableError(unapprovedReport(projection));
		}
		const approvedChanged = Array.from(approvedItemIds).some(
			(itemId) => !stored?.decision.approvedItemIds.includes(itemId),
		);
		if (!approvedChanged || options.persistApproval === false) {
			return stored ? { ...projection, decisionEntryId: stored.entryId } : projection;
		}

		const decision: StoredPortabilityDecision = {
			version: 2,
			acceptedLoss: true,
			timestamp: Date.now(),
			targetKey: getPortabilityTargetKey(projection.target),
			approvedItemIds: Array.from(approvedItemIds),
			report: projection.report,
		};
		const decisionEntryId = this.store.appendCustomEntry(DECISION_TYPE, decision);
		return { ...projection, decisionEntryId };
	}

	private project(
		messages: readonly Message[],
		target: Model<any>,
		approvedItemIds: Iterable<string>,
	): AppliedPortabilityProjection {
		return projectConversationForTarget({
			messages,
			attachments: this.listAttachments(),
			target,
			sourceAvailable: this.sourceAvailable,
			approvedItemIds,
		});
	}

	private findDecision(target: Model<any>): { entryId: string; decision: StoredPortabilityDecision } | undefined {
		const targetKey = getPortabilityTargetKey({
			provider: target.provider,
			api: target.api,
			modelId: target.id,
			baseUrl: target.baseUrl,
		});
		const branch = this.store.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== DECISION_TYPE || !isStoredDecision(entry.data)) continue;
			if (entry.data.targetKey === targetKey) return { entryId: entry.id, decision: entry.data };
		}
		return undefined;
	}
}

export class PortabilityProjectionUnavailableError extends Error {
	readonly report: PortabilityReport;
	readonly phase: "preflight" | "mid-run";

	constructor(report: PortabilityReport, phase: "preflight" | "mid-run" = "preflight") {
		const item = report.items[0];
		const subject = item?.filename ?? item?.attachmentId ?? item?.kind ?? "Provider-native context";
		const reason = item?.reason ?? "it cannot be projected safely";
		const nextAction = item?.projectable
			? "Re-send a prompt and approve excluding it, or switch to a model that supports it."
			: "It has no stable identity and cannot be excluded safely. Switch to its owning model or start a clean session.";
		super(`${subject} was not sent to ${report.target.provider}/${report.target.modelId}: ${reason}. ${nextAction}`);
		this.name = "PortabilityProjectionUnavailableError";
		this.report = report;
		this.phase = phase;
	}
}
