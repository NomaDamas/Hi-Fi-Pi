import type { AttachmentRecord } from "@earendil-works/pi-ai/compat";
import { Box, Container, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private attachments: readonly AttachmentRecord[];
	private unresolvedAttachmentIds: readonly string[];

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		attachments: readonly AttachmentRecord[] = [],
		unresolvedAttachmentIds: readonly string[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.attachments = attachments;
		this.unresolvedAttachmentIds = unresolvedAttachmentIds;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
		contentBox.addChild(
			new Markdown(
				this.text,
				0,
				0,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
			),
		);
		if (this.attachments.length > 0 || this.unresolvedAttachmentIds.length > 0) {
			contentBox.addChild(new Text(this.formatAttachments(), 0, 0));
		}
		this.addChild(contentBox);
	}

	private formatAttachments(): string {
		const lines = [theme.bold("Attachments")];
		for (const attachment of this.attachments) {
			const details = [attachment.mediaType];
			if (attachment.sizeBytes !== undefined) details.push(formatAttachmentSize(attachment.sizeBytes));
			const nativeMethod = stringMetadata(attachment, "nativeMethod");
			const status = stringMetadata(attachment, "preparationStatus");
			if (nativeMethod) details.push(nativeMethod);
			if (status) details.push(status);
			lines.push(`• ${attachment.filename} · ${details.join(" · ")}`);
			if (attachment.metadata?.sourceAvailable === false && attachment.source.type === "path") {
				lines.push(`  source missing · ${attachment.source.path}`);
			}
		}
		for (const attachmentId of this.unresolvedAttachmentIds) {
			lines.push(`• unavailable attachment · ${attachmentId}`);
		}
		return lines.join("\n");
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}

function stringMetadata(attachment: AttachmentRecord, key: string): string | undefined {
	const value = attachment.metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
