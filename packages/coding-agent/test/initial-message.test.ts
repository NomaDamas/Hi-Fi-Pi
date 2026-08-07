import type { AttachmentRecord } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { buildInitialMessage } from "../src/cli/initial-message.ts";

function createArgs(messages: string[] = []): Args {
	return {
		messages: [...messages],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
}

describe("buildInitialMessage", () => {
	test("merges piped stdin with the first CLI message into one prompt", () => {
		const parsed = createArgs(["Summarize the text given"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents\n",
		});

		expect(result.initialMessage).toBe("README contents\nSummarize the text given");
		expect(parsed.messages).toEqual([]);
	});

	test("uses stdin as the initial prompt when no CLI message is present", () => {
		const parsed = createArgs();
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents",
		});

		expect(result.initialMessage).toBe("README contents");
		expect(parsed.messages).toEqual([]);
	});

	test("combines stdin, file text, and first CLI message in one prompt", () => {
		const parsed = createArgs(["Explain it", "Second message"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "stdin\n",
			fileText: "file\n",
		});

		expect(result.initialMessage).toBe("stdin\nfile\nExplain it");
		expect(parsed.messages).toEqual(["Second message"]);
	});

	test("preserves prepared native attachments without changing prompt text", () => {
		const parsed = createArgs(["Analyze the document"]);
		const attachment: AttachmentRecord = {
			id: "att_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			sizeBytes: 128,
			source: { type: "path", path: "/tmp/paper.pdf" },
		};

		const result = buildInitialMessage({
			parsed,
			fileAttachments: [attachment],
		});

		expect(result.initialMessage).toBe("Analyze the document");
		expect(result.initialAttachments).toEqual([attachment]);
	});
});
