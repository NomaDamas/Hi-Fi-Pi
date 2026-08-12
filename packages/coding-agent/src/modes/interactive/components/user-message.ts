import { Box, Container, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import { formatAttachmentSize, formatAttachmentStatus } from "../../../core/attachments/attachment-presentation.ts";
import type { ResolvedAttachment } from "../../../core/attachments/attachment-runtime.ts";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

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
	private markdownTransformers: readonly MarkdownTransformer[];
	private attachments: readonly ResolvedAttachment[];
	private unresolvedAttachmentIds: readonly string[];

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		attachments: readonly ResolvedAttachment[] = [],
		unresolvedAttachmentIds: readonly string[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
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
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform("user", false, this.markdownTransformers),
				},
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
			const details = [attachment.record.mediaType];
			if (attachment.record.sizeBytes !== undefined) details.push(formatAttachmentSize(attachment.record.sizeBytes));
			if (attachment.state.transport.nativeMethod) details.push(attachment.state.transport.nativeMethod);
			details.push(formatAttachmentStatus(attachment));
			lines.push(`• ${attachment.record.filename} · ${details.join(" · ")}`);
			if (attachment.state.source.status === "missing" && attachment.record.source.type === "path") {
				lines.push(`  source missing · ${attachment.record.source.path}`);
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
