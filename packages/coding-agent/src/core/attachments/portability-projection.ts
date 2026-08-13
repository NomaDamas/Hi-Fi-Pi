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

function lossyItemIds(report: PortabilityReport): string[] {
	return Array.from(
		new Set(
			report.items
				.filter(
					(item) =>
						item.projectable &&
						(item.classification === "provider-locked" ||
							item.classification === "missing" ||
							item.classification === "unsupported"),
				)
				.map((item) => item.stableId),
		),
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
		options: { allowLossy?: boolean } = {},
	): AppliedPortabilityProjection {
		const projection = this.inspect(messages, target);
		if (projection.unapprovedItemIds.length === 0) return projection;
		if (!options.allowLossy) throw new PortabilityConfirmationRequiredError(unapprovedReport(projection));
		if (
			projection.report.items.some(
				(item) =>
					!item.projectable &&
					(item.classification === "provider-locked" ||
						item.classification === "missing" ||
						item.classification === "unsupported"),
			)
		) {
			throw new PortabilityProjectionUnavailableError(unapprovedReport(projection));
		}

		const decision: StoredPortabilityDecision = {
			version: 2,
			acceptedLoss: true,
			timestamp: Date.now(),
			targetKey: getPortabilityTargetKey(projection.target),
			approvedItemIds: lossyItemIds(projection.report),
			report: projection.report,
		};
		const decisionEntryId = this.store.appendCustomEntry(DECISION_TYPE, decision);
		const confirmed = {
			...projectConversationForTarget({
				messages,
				attachments: this.listAttachments(),
				target,
				sourceAvailable: this.sourceAvailable,
				approvedItemIds: decision.approvedItemIds,
			}),
			decisionEntryId,
		};
		if (confirmed.unapprovedItemIds.length > 0) {
			throw new PortabilityProjectionUnavailableError(unapprovedReport(confirmed));
		}
		return confirmed;
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

	constructor(report: PortabilityReport) {
		super("Some incompatible provider-native state has no stable identity and cannot be suspended safely.");
		this.name = "PortabilityProjectionUnavailableError";
		this.report = report;
	}
}
