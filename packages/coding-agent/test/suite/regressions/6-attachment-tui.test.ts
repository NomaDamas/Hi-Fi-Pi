import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentRecord, ProviderTraceEvent } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../../src/core/slash-commands.ts";
import { UserMessageComponent } from "../../../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const pdf: AttachmentRecord = {
	id: "att_pdf",
	filename: "paper.pdf",
	mediaType: "application/pdf",
	sizeBytes: 2_457_600,
	source: { type: "path", path: "/missing/paper.pdf" },
	metadata: {
		preparationStatus: "ready",
		nativeMethod: "OpenAI input_file",
		sourceAvailable: false,
	},
};

const spreadsheet: AttachmentRecord = {
	id: "att_sheet",
	filename: "results.xlsx",
	mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	sizeBytes: 32_768,
	source: { type: "path", path: "/missing/results.xlsx" },
	metadata: { preparationStatus: "uploading" },
};

type AttachmentAwareUserMessageComponent = new (
	text: string,
	markdownTheme?: ConstructorParameters<typeof UserMessageComponent>[1],
	outputPad?: number,
	attachments?: AttachmentRecord[],
	unresolvedAttachmentIds?: string[],
) => UserMessageComponent;

function renderAttachmentMessage(attachments: AttachmentRecord[], width = 80): string[] {
	const Component = UserMessageComponent as AttachmentAwareUserMessageComponent;
	return new Component("Analyze these files", undefined, 1, attachments).render(width).map(stripAnsi);
}

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { setText: ReturnType<typeof vi.fn>; addToHistory: ReturnType<typeof vi.fn> };
	session: { isCompacting: boolean; isStreaming: boolean; isBashRunning: boolean; prompt: ReturnType<typeof vi.fn> };
	flushPendingBashComponents: ReturnType<typeof vi.fn>;
	pendingUserInputs: string[];
	handleFilesCommand: ReturnType<typeof vi.fn>;
	handleFileCommand: ReturnType<typeof vi.fn>;
	handleCapabilitiesCommand: ReturnType<typeof vi.fn>;
	handleInputInspectCommand: ReturnType<typeof vi.fn>;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	handleFilesCommand(this: CommandContext): void;
	handleFileCommand(this: CommandContext, selector: string): void;
	handleCapabilitiesCommand(this: CommandContext): void;
	handleInputInspectCommand(this: CommandContext): void;
	addMessageToChat(this: MessageContext, message: unknown): void;
	updateAttachmentPreview(this: PreviewContext, text: string): Promise<void>;
	handleInteractiveInputError(this: InputErrorContext, text: string, error: unknown): void;
};

type PreviewContext = {
	attachmentPreviewContainer: Container;
	attachmentPreviewRevision: number;
	ui: { requestRender: ReturnType<typeof vi.fn> };
};

type InputErrorContext = {
	editor: { setText: ReturnType<typeof vi.fn> };
	showError: ReturnType<typeof vi.fn>;
};

type MessageContext = {
	chatContainer: Container;
	session: CommandContext["session"];
	sessionManager: { getAttachment: (id: string) => AttachmentRecord | undefined };
	getUserMessageText: () => string;
	getMarkdownThemeWithSettings: () => ReturnType<typeof getMarkdownTheme>;
	outputPad: number;
	toolOutputExpanded: boolean;
	editor: { addToHistory: ReturnType<typeof vi.fn> };
};

type CommandContext = {
	sessionManager: {
		getAttachments: () => AttachmentRecord[];
		getAttachment: (id: string) => AttachmentRecord | undefined;
	};
	session: {
		model?: { provider: string; id: string; api: string; baseUrl: string; input: string[] };
		getProviderTraceEvents: () => ProviderTraceEvent[];
	};
	chatContainer: Container;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	showWarning: ReturnType<typeof vi.fn>;
};

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
		handleFilesCommand: vi.fn(),
		handleFileCommand: vi.fn(),
		handleCapabilitiesCommand: vi.fn(),
		handleInputInspectCommand: vi.fn(),
	};
}

function createCommandContext(attachments: AttachmentRecord[] = [pdf]): CommandContext {
	return {
		sessionManager: {
			getAttachments: () => attachments,
			getAttachment: (id) => attachments.find((attachment) => attachment.id === id),
		},
		session: {
			model: {
				provider: "openai",
				id: "gpt-test",
				api: "openai-responses",
				baseUrl: "https://api.openai.com/v1",
				input: ["text", "image"],
			},
			getProviderTraceEvents: () => [],
		},
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		showWarning: vi.fn(),
	};
}

function renderCommandOutput(context: CommandContext): string {
	return context.chatContainer.render(100).map(stripAnsi).join("\n");
}

describe("Issue 6 attachment TUI contracts", () => {
	beforeEach(() => initTheme("dark"));

	it("renders filename, media type, size, native method, and status under a user message", () => {
		const output = renderAttachmentMessage([pdf]).join("\n");

		expect(output).toContain("Attachments");
		expect(output).toContain("paper.pdf");
		expect(output).toContain("application/pdf");
		expect(output).toContain("2.3 MB");
		expect(output).toContain("OpenAI input_file");
		expect(output).toContain("ready");
	});

	it("shows a missing local source without attempting to read the file", () => {
		const output = renderAttachmentMessage([pdf]).join("\n");

		expect(output).toContain("source missing");
		expect(output).toContain("/missing/paper.pdf");
	});

	it("renders multiple attachment statuses in a narrow terminal", () => {
		const lines = renderAttachmentMessage([pdf, spreadsheet], 28);
		const output = lines.join("\n");

		expect(lines.every((line) => line.length <= 28)).toBe(true);
		expect(output).toContain("paper.pdf");
		expect(output).toContain("results.xlsx");
		expect(output).toContain("uploading");
	});

	it("keeps legacy user message rendering byte-for-byte unchanged", () => {
		const legacy = new UserMessageComponent("hello").render(40);
		const Component = UserMessageComponent as AttachmentAwareUserMessageComponent;
		const additive = new Component("hello", undefined, 1, undefined).render(40);

		expect(additive).toEqual(legacy);
	});

	it("resolves persisted attachment references when rendering a user message", () => {
		const context: MessageContext = {
			chatContainer: new Container(),
			session: createCommandContext().session,
			sessionManager: { getAttachment: (id) => (id === pdf.id ? pdf : undefined) },
			getUserMessageText: () => "Analyze after resume",
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			outputPad: 1,
			toolOutputExpanded: false,
			editor: { addToHistory: vi.fn() },
		};
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.addMessageToChat.call(context, {
			role: "user",
			content: "Analyze after resume",
			attachments: [{ type: "attachment", attachmentId: pdf.id }],
			timestamp: 1,
		});

		const output = context.chatContainer.render(80).map(stripAnsi).join("\n");
		expect(output).toContain("Analyze after resume");
		expect(output).toContain("paper.pdf");
	});

	it("shows dangling attachment references instead of silently dropping them", () => {
		const context: MessageContext = {
			chatContainer: new Container(),
			session: createCommandContext().session,
			sessionManager: { getAttachment: () => undefined },
			getUserMessageText: () => "Analyze after resume",
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			outputPad: 1,
			toolOutputExpanded: false,
			editor: { addToHistory: vi.fn() },
		};
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.addMessageToChat.call(context, {
			role: "user",
			content: "Analyze after resume",
			attachments: [{ type: "attachment", attachmentId: "att_missing" }],
			timestamp: 1,
		});

		const output = context.chatContainer.render(80).map(stripAnsi).join("\n");
		expect(output).toContain("unavailable attachment");
		expect(output).toContain("att_missing");
	});

	it("registers attachment inspection commands in slash command discovery", () => {
		const commands = BUILTIN_SLASH_COMMANDS.map((command) => command.name);

		expect(commands).toEqual(expect.arrayContaining(["files", "file", "capabilities", "input-inspect"]));
	});

	it("shows selected native @file names before submission", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "pi-attachment-preview-"));
		const paperPath = join(testDir, "paper.pdf");
		const slidesPath = join(testDir, "slides deck.pptx");
		writeFileSync(paperPath, Buffer.from("%PDF-1.7\nbinary\n"));
		writeFileSync(slidesPath, Buffer.from("PK\x03\x04\x00\x00", "binary"));
		const context: PreviewContext = {
			attachmentPreviewContainer: new Container(),
			attachmentPreviewRevision: 0,
			ui: { requestRender: vi.fn() },
		};
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		try {
			await prototype.updateAttachmentPreview.call(context, `@"${paperPath}" @"${slidesPath}" Analyze`);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}

		const output = context.attachmentPreviewContainer.render(80).map(stripAnsi).join("\n");
		expect(output).toContain("Attachments: paper.pdf, slides deck.pptx");
		expect(context.ui.requestRender).toHaveBeenCalled();
	});

	it("does not preview directories, missing paths, scoped packages, text files, or images as native attachments", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "pi-attachment-preview-"));
		const directoryPath = join(testDir, "packages");
		const textPath = join(testDir, "note.txt");
		const imagePath = join(testDir, "figure.png");
		mkdirSync(directoryPath);
		writeFileSync(textPath, "plain text\n");
		writeFileSync(
			imagePath,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		const context: PreviewContext = {
			attachmentPreviewContainer: new Container(),
			attachmentPreviewRevision: 0,
			ui: { requestRender: vi.fn() },
		};
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		try {
			await prototype.updateAttachmentPreview.call(
				context,
				`@"${directoryPath}" @"${textPath}" @"${imagePath}" @types/node @user.name @missing.pdf`,
			);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}

		expect(context.attachmentPreviewContainer.render(80)).toEqual([]);
	});

	it("restores an idle submission when attachment preprocessing fails", () => {
		const context: InputErrorContext = {
			editor: { setText: vi.fn() },
			showError: vi.fn(),
		};
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

		prototype.handleInteractiveInputError.call(context, "analyze @paper.pdf", new Error("read failed"));

		expect(context.editor.setText).toHaveBeenCalledWith("analyze @paper.pdf");
		expect(context.showError).toHaveBeenCalledWith("read failed");
	});

	it("routes /files without submitting it as a model prompt", async () => {
		const context = createSubmitContext();
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/files");

		expect(context.handleFilesCommand).toHaveBeenCalledOnce();
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("routes /file N to attachment detail inspection", async () => {
		const context = createSubmitContext();
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/file 2");

		expect(context.handleFileCommand).toHaveBeenCalledWith("2");
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("routes /capabilities to current transport inspection", async () => {
		const context = createSubmitContext();
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/capabilities");

		expect(context.handleCapabilitiesCommand).toHaveBeenCalledOnce();
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("routes /input-inspect to sanitized provider trace inspection", async () => {
		const context = createSubmitContext();
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/input-inspect");

		expect(context.handleInputInspectCommand).toHaveBeenCalledOnce();
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("renders the latest sanitized provider trace stages", () => {
		const context = createCommandContext();
		context.session.getProviderTraceEvents = () => [
			{
				type: "provider_trace",
				traceId: "provider_trace_1",
				sequence: 0,
				timestamp: 1,
				stage: "capability_decision",
				provider: "openai",
				api: "openai-responses",
				modelId: "gpt-test",
				endpointProfile: "openai-responses-official",
				capability: { supported: true, wireKind: "input_file", provenance: "official-default" },
			},
			{
				type: "provider_trace",
				traceId: "provider_trace_1",
				sequence: 1,
				timestamp: 2,
				stage: "sanitized_wire_payload",
				provider: "openai",
				api: "openai-responses",
				modelId: "gpt-test",
				payload: { input: [{ type: "input_file", file_data: "[redacted binary data]" }] },
			},
		];
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.handleInputInspectCommand.call(context);
		const output = renderCommandOutput(context);

		expect(output).toContain("Latest Provider Input Trace");
		expect(output).toContain("capability_decision");
		expect(output).toContain("input_file");
		expect(output).toContain("[redacted binary data]");
	});

	it("lists attachment metadata and preparation status", () => {
		const context = createCommandContext([pdf, spreadsheet]);
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.handleFilesCommand.call(context);
		const output = renderCommandOutput(context);

		expect(output).toContain("1. paper.pdf · application/pdf · 2.3 MB · source missing");
		expect(output).toContain("2. results.xlsx");
		expect(output).toContain("source missing");
		expect(context.ui.requestRender).toHaveBeenCalledOnce();
	});

	it("renders a useful empty attachment list", () => {
		const context = createCommandContext([]);
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.handleFilesCommand.call(context);

		expect(renderCommandOutput(context)).toContain("No attachments in this session.");
	});

	it("inspects an attachment by index and shows missing source state", () => {
		const context = createCommandContext([spreadsheet, pdf]);
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.handleFileCommand.call(context, "2");
		const output = renderCommandOutput(context);

		expect(output).toContain("Attachment Details");
		expect(output).toContain("att_pdf");
		expect(output).toContain("/missing/paper.pdf (missing)");
		expect(output).toContain("Native method: input_file");
		expect(output).toContain("Status: source missing");
	});

	it("redacts inline bytes and displays provider remote identity", () => {
		const inline: AttachmentRecord = {
			...pdf,
			id: "att_inline",
			source: { type: "base64", data: "JVBERi0xLjQKSECRET" },
			remotes: {
				openai: {
					provider: "openai",
					api: "openai-responses",
					fileId: "file_123",
					uploadedAt: 1,
				},
			},
		};
		const context = createCommandContext([inline]);
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.handleFileCommand.call(context, "att_inline");
		const output = renderCommandOutput(context);

		expect(output).toContain("inline base64 (data redacted)");
		expect(output).not.toContain("SECRET");
		expect(output).toContain("Remote (openai): file_123");
	});

	it("shows a transport-derived unsupported status and reason", () => {
		const video: AttachmentRecord = {
			id: "att_video",
			filename: "demo.mp4",
			mediaType: "video/mp4",
			source: { type: "base64", data: "AAAA" },
		};
		const context = createCommandContext([video]);
		context.session.model = {
			provider: "anthropic",
			id: "claude-test",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			input: ["text", "image"],
		};
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.handleFileCommand.call(context, "1");
		const output = renderCommandOutput(context);

		expect(output).toContain("Status: unsupported");
		expect(output).toContain("Reason: only application/pdf is enabled");
	});

	it("reports the selected model transport and native PDF capability", () => {
		const context = createCommandContext();
		const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
		prototype.handleCapabilitiesCommand.call(context);
		const output = renderCommandOutput(context);

		expect(output).toContain("Provider: openai");
		expect(output).toContain("Model: gpt-test");
		expect(output).toContain("Transport: openai-responses");
		expect(output).toContain("Declared inputs: text, image");
		expect(output).toContain("Endpoint profile: openai-official");
		expect(output).toContain("Native openai-responses-pdf: supported");
		expect(output).toContain("inline→input_file");
		expect(output).toContain("official-default");
		expect(output).toContain("PDF: native via input_file");
	});
});
