import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractPromptFileReferences,
	processFileArguments,
	processPromptFileReferences,
} from "../src/cli/file-processor.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("processFileArguments attachment classification", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-file-attachments-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("keeps UTF-8 text files on the legacy inline-text path", async () => {
		const markdownPath = join(testDir, "README.md");
		const sourcePath = join(testDir, "main.ts");
		const csvPath = join(testDir, "data.csv");
		writeFileSync(markdownPath, "# Hi-Fi Pi\n");
		writeFileSync(sourcePath, 'export const project = "Hi-Fi Pi";\n');
		writeFileSync(csvPath, "provider,status\nopenai,ready\n");

		const result = await processFileArguments([markdownPath, sourcePath, csvPath]);

		expect(result.text).toContain("# Hi-Fi Pi");
		expect(result.text).toContain('export const project = "Hi-Fi Pi"');
		expect(result.text).toContain("provider,status");
		expect(result.images).toEqual([]);
		expect(result.attachments).toEqual([]);
	});

	it("keeps supported images on the legacy image path", async () => {
		const path = join(testDir, "figure.png");
		writeFileSync(path, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await processFileArguments([path]);

		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.mimeType).toBe("image/png");
		expect(result.attachments).toEqual([]);
	});

	it("preserves a PDF as a local attachment without decoding it as UTF-8", async () => {
		const path = join(testDir, "paper.pdf");
		const bytes = Buffer.from("%PDF-1.7\n%\xff\xff\xff\xff\n", "binary");
		writeFileSync(path, bytes);

		const result = await processFileArguments([path]);

		expect(result.images).toEqual([]);
		expect(result.text).not.toContain("%PDF");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]).toMatchObject({
			filename: "paper.pdf",
			mediaType: "application/pdf",
			sizeBytes: bytes.length,
			source: {
				type: "path",
				path: resolve(path),
			},
		});
		expect(result.attachments[0]?.id).toEqual(expect.any(String));
	});

	it("prefers PDF magic bytes over a misleading extension", async () => {
		const path = join(testDir, "not-really-text.txt");
		writeFileSync(path, Buffer.from("%PDF-1.4\nbinary\n"));

		const result = await processFileArguments([path]);

		expect(result.text).not.toContain("%PDF");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]?.mediaType).toBe("application/pdf");
	});

	it.each([
		["document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
		["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
		["workbook.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
		["recording.wav", "audio/wav"],
		["demo.mp4", "video/mp4"],
	])("classifies %s as %s instead of inline text", async (filename, mediaType) => {
		const path = join(testDir, filename);
		writeFileSync(path, binaryFixtureFor(filename));

		const result = await processFileArguments([path]);

		expect(result.text).toBe("");
		expect(result.images).toEqual([]);
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]).toMatchObject({
			filename,
			mediaType,
			source: { type: "path", path: resolve(path) },
		});
	});

	it("uses application/octet-stream for an unknown binary file", async () => {
		const path = join(testDir, "payload.unknown");
		writeFileSync(path, Buffer.from([0x00, 0xff, 0x10, 0x80]));

		const result = await processFileArguments([path]);

		expect(result.text).toBe("");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]?.mediaType).toBe("application/octet-stream");
	});

	it("combines legacy text and image inputs with typed attachments", async () => {
		const textPath = join(testDir, "notes.txt");
		const imagePath = join(testDir, "figure.png");
		const pdfPath = join(testDir, "paper.pdf");
		writeFileSync(textPath, "Read alongside the figure and paper.");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
		writeFileSync(pdfPath, Buffer.from("%PDF-1.7\nbinary\n"));

		const result = await processFileArguments([textPath, imagePath, pdfPath]);

		expect(result.text).toContain("Read alongside the figure and paper.");
		expect(result.images).toHaveLength(1);
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]?.filename).toBe("paper.pdf");
	});

	it("extracts unquoted and quoted interactive @file references without treating emails as files", () => {
		const result = extractPromptFileReferences(
			'Analyze @paper.pdf and @"slides deck.pptx" then email test@example.com',
		);

		expect(result.fileArgs).toEqual(["paper.pdf", "slides deck.pptx"]);
		expect(result.text).toBe("Analyze  and  then email test@example.com");
	});

	it("preserves plain @mentions while extracting path-like file references", async () => {
		const extracted = extractPromptFileReferences("Ask @alice to review @paper.pdf");

		expect(extracted.fileArgs).toEqual(["paper.pdf"]);
		expect(extracted.text).toBe("Ask @alice to review");

		await expect(processPromptFileReferences("Ask @alice for status", { failureMode: "throw" })).resolves.toEqual({
			text: "Ask @alice for status",
			images: [],
			attachments: [],
		});
	});

	it("processes interactive text plus a PDF through the typed attachment path", async () => {
		const pdfPath = join(testDir, "paper.pdf");
		writeFileSync(pdfPath, Buffer.from("%PDF-1.7\nbinary\n"));

		const result = await processPromptFileReferences(`@"${pdfPath}" Analyze the equations`, {
			failureMode: "throw",
		});

		expect(result.text).toBe("Analyze the equations");
		expect(result.images).toEqual([]);
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]).toMatchObject({
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "path", path: resolve(pdfPath) },
		});
	});

	it("preserves attachment argument order", async () => {
		const paths = ["paper-a.pdf", "paper-b.pdf"].map((filename) => {
			const path = join(testDir, filename);
			writeFileSync(path, Buffer.from("%PDF-1.7\nbinary\n"));
			return path;
		});

		const result = await processFileArguments(paths);

		expect(result.attachments.map((attachment) => basename(attachment.filename))).toEqual([
			"paper-a.pdf",
			"paper-b.pdf",
		]);
	});

	it("fails clearly when an input file does not exist", async () => {
		const missingPath = join(testDir, "missing.pdf");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit(1)");
		}) as typeof process.exit);

		await expect(processFileArguments([missingPath])).rejects.toThrow("process.exit(1)");
		expect(exit).toHaveBeenCalledWith(1);
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(`File not found: ${resolve(missingPath)}`));

		exit.mockRestore();
		consoleError.mockRestore();
	});
});

function binaryFixtureFor(filename: string): Buffer {
	if (filename.endsWith(".wav")) {
		return Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "binary");
	}
	if (filename.endsWith(".mp4")) {
		return Buffer.from("\x00\x00\x00\x18ftypisom", "binary");
	}
	return Buffer.from("PK\x03\x04\x00\x00\x00\x00", "binary");
}
