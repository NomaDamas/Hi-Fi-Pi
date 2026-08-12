import { existsSync } from "node:fs";
import { getNativeAttachmentCapability, getNativeInputCapabilityManifest } from "@earendil-works/pi-ai";
import type { Api, AttachmentRecord, AttachmentReference, Model } from "@earendil-works/pi-ai/compat";
import {
	type ResolvedAttachment,
	resolveAttachmentRuntime,
	resolveAttachmentSourceRuntime,
} from "./attachment-runtime.ts";

export interface AttachmentPresentationStyle {
	bold(text: string): string;
	dim(text: string): string;
}

export interface AttachmentResolutionEnvironment {
	now?: number;
	pathExists?: (path: string) => boolean;
	redactInlineData?: boolean;
}

export interface ResolvedAttachmentReferences {
	attachments: ResolvedAttachment[];
	unresolvedAttachmentIds: string[];
}

export type AttachmentCommandResult = { type: "content"; text: string } | { type: "warning"; message: string };

export function resolveAttachmentForPresentation(
	record: AttachmentRecord,
	model: Model<Api> | undefined,
	environment: AttachmentResolutionEnvironment = {},
): ResolvedAttachment {
	const now = environment.now ?? Date.now();
	const pathExists = environment.pathExists ?? existsSync;
	return resolveAttachmentRuntime(record, {
		model,
		now,
		source: resolveAttachmentSourceRuntime(record, {
			now,
			pathExists,
			redactInlineData: environment.redactInlineData,
		}),
	});
}

export function resolveAttachmentReferencesForPresentation(
	references: readonly AttachmentReference[] | undefined,
	resolveRecord: (id: string) => AttachmentRecord | undefined,
	model: Model<Api> | undefined,
	environment?: AttachmentResolutionEnvironment,
): ResolvedAttachmentReferences {
	const attachments: ResolvedAttachment[] = [];
	const unresolvedAttachmentIds: string[] = [];
	for (const reference of references ?? []) {
		const record = resolveRecord(reference.attachmentId);
		if (record) attachments.push(resolveAttachmentForPresentation(record, model, environment));
		else unresolvedAttachmentIds.push(reference.attachmentId);
	}
	return { attachments, unresolvedAttachmentIds };
}

export function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatAttachmentSource(attachment: ResolvedAttachment): string {
	const { record, state } = attachment;
	switch (record.source.type) {
		case "path":
			return state.source.status === "missing" ? `${record.source.path} (missing)` : record.source.path;
		case "url":
			return record.source.url;
		case "cloud-uri":
			return record.source.uri;
		case "base64":
			return "inline base64 (data redacted)";
		case "provider-file":
			return `${record.source.provider} file ${record.source.fileId}`;
	}
}

export function formatAttachmentStatus(attachment: ResolvedAttachment): string {
	if (attachment.state.source.status === "missing") return "source missing";
	if (attachment.state.source.status === "redacted") return "source redacted";
	return attachment.state.transport.status;
}

export function formatAttachmentList(
	records: readonly AttachmentRecord[],
	model: Model<Api> | undefined,
	style: AttachmentPresentationStyle,
	environment?: AttachmentResolutionEnvironment,
): string {
	let text = style.bold("Session Attachments");
	if (records.length === 0) return `${text}\n\n${style.dim("No attachments in this session.")}`;

	for (const [index, record] of records.entries()) {
		const attachment = resolveAttachmentForPresentation(record, model, environment);
		const size = record.sizeBytes === undefined ? "size unknown" : formatAttachmentSize(record.sizeBytes);
		text += `\n${index + 1}. ${record.filename} · ${record.mediaType} · ${size} · ${formatAttachmentStatus(attachment)}`;
	}
	return text;
}

export function formatAttachmentDetails(
	records: readonly AttachmentRecord[],
	selector: string,
	model: Model<Api> | undefined,
	style: AttachmentPresentationStyle,
	environment?: AttachmentResolutionEnvironment,
): AttachmentCommandResult {
	const numericIndex = /^\d+$/.test(selector) ? Number(selector) - 1 : -1;
	const record = numericIndex >= 0 ? records[numericIndex] : records.find((candidate) => candidate.id === selector);
	if (!selector || !record) {
		return {
			type: "warning",
			message: selector ? `Attachment not found: ${selector}` : "Usage: /file <number-or-id>",
		};
	}

	const attachment = resolveAttachmentForPresentation(record, model, environment);
	let text = `${style.bold("Attachment Details")}\n\n`;
	text += `${style.dim("Filename:")} ${record.filename}\n`;
	text += `${style.dim("ID:")} ${record.id}\n`;
	text += `${style.dim("MIME:")} ${record.mediaType}\n`;
	if (record.sizeBytes !== undefined) text += `${style.dim("Size:")} ${formatAttachmentSize(record.sizeBytes)}\n`;
	text += `${style.dim("Source:")} ${formatAttachmentSource(attachment)}`;
	if (attachment.state.transport.nativeMethod) {
		text += `\n${style.dim("Native method:")} ${attachment.state.transport.nativeMethod}`;
	}
	text += `\n${style.dim("Status:")} ${formatAttachmentStatus(attachment)}`;
	if (attachment.state.transport.reason) {
		text += `\n${style.dim("Reason:")} ${attachment.state.transport.reason}`;
	}
	for (const [provider, remote] of Object.entries(record.remotes ?? {})) {
		text += `\n${style.dim(`Remote (${provider}):`)} ${remote.fileId}${remote.uri ? ` · ${remote.uri}` : ""}`;
	}
	return { type: "content", text };
}

export function formatAttachmentCapabilities(
	model: Model<Api> | undefined,
	style: AttachmentPresentationStyle,
): AttachmentCommandResult {
	if (!model) return { type: "warning", message: "No model is currently selected." };

	let text = `${style.bold("Current Input Capabilities")}\n\n`;
	text += `${style.dim("Provider:")} ${model.provider}\n`;
	text += `${style.dim("Model:")} ${model.id}\n`;
	text += `${style.dim("Transport:")} ${model.api}\n`;
	text += `${style.dim("Declared inputs:")} ${model.input.join(", ") || "none"}\n`;
	const manifest = getNativeInputCapabilityManifest(model);
	if (manifest) {
		text += `${style.dim("Endpoint profile:")} ${manifest.endpointProfile}\n`;
		for (const capability of manifest.capabilities) {
			const transports = capability.sources
				.map((source) => `${source}→${capability.wireKinds[source] ?? "undeclared"}`)
				.join(", ");
			text += `${style.dim(`Native ${capability.id}:`)} ${
				capability.supported ? "supported" : `unsupported${capability.reason ? ` · ${capability.reason}` : ""}`
			} · ${capability.mediaTypes.join(", ")} · ${transports} · ${capability.provenance}\n`;
		}
	} else {
		text += `${style.dim("Endpoint profile:")} none (explicit opt-in required)\n`;
	}
	const pdfCapability = getNativeAttachmentCapability(model, "application/pdf");
	text += `${style.dim("PDF:")} ${
		pdfCapability.supported ? `native via ${pdfCapability.method}` : `unsupported · ${pdfCapability.reason}`
	}`;
	return { type: "content", text };
}
