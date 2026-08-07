/**
 * Process @file CLI arguments into text content and image attachments
 */

import { randomUUID } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import type { AttachmentRecord, ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { basename, resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectAttachmentMimeTypeFromFile, detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
	attachments: AttachmentRecord[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** CLI preserves its historical exit behavior; interactive callers should request an exception. */
	failureMode?: "exit" | "throw";
}

export interface PromptFileReferences {
	text: string;
	fileArgs: string[];
}

interface PromptFileReferenceCandidate {
	path: string;
	start: number;
	end: number;
}

function isPathLikeFileReference(value: string): boolean {
	return (
		value.startsWith(".") ||
		value.startsWith("~") ||
		value.startsWith("/") ||
		value.includes("/") ||
		value.includes("\\") ||
		/[^/\\\s]+\.[A-Za-z0-9]{1,16}$/.test(value)
	);
}

export function extractPromptFileReferences(input: string): PromptFileReferences {
	const candidates = findPromptFileReferenceCandidates(input);
	let text = "";
	let index = 0;
	for (const candidate of candidates) {
		text += input.slice(index, candidate.start);
		index = candidate.end;
	}
	text += input.slice(index);

	return {
		text: text.replace(/[ \t]+\n/g, "\n").trim(),
		fileArgs: candidates.map((candidate) => candidate.path),
	};
}

function findPromptFileReferenceCandidates(input: string): PromptFileReferenceCandidate[] {
	const candidates: PromptFileReferenceCandidate[] = [];
	let index = 0;

	while (index < input.length) {
		const isTokenBoundary = index === 0 || /\s/.test(input[index - 1] ?? "");
		if (input[index] !== "@" || !isTokenBoundary) {
			index += 1;
			continue;
		}

		if (input[index + 1] === '"') {
			const closingQuote = input.indexOf('"', index + 2);
			if (closingQuote !== -1) {
				const path = input.slice(index + 2, closingQuote);
				if (path.length > 0) {
					candidates.push({ path, start: index, end: closingQuote + 1 });
					index = closingQuote + 1;
					continue;
				}
			}
		}

		let end = index + 1;
		while (end < input.length && !/\s/.test(input[end] ?? "")) end += 1;
		const path = input.slice(index + 1, end);
		if (path.length > 0 && isPathLikeFileReference(path)) {
			candidates.push({ path, start: index, end });
			index = end;
			continue;
		}
		index = path.length > 0 ? end : index + 1;
	}

	return candidates;
}

export async function processPromptFileReferences(
	input: string,
	_options?: ProcessFileOptions,
): Promise<ProcessedFiles> {
	const candidates = findPromptFileReferenceCandidates(input);
	if (candidates.length === 0) {
		return { text: input, images: [], attachments: [] };
	}

	const resolved = await Promise.all(candidates.map((candidate) => resolveNativePromptAttachment(candidate.path)));
	if (resolved.every((attachment) => attachment === undefined)) {
		return { text: input, images: [], attachments: [] };
	}

	const attachments: AttachmentRecord[] = [];
	let text = "";
	let index = 0;
	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
		const candidate = candidates[candidateIndex];
		const attachment = resolved[candidateIndex];
		if (!candidate) continue;
		text += input.slice(index, candidate.start);
		if (attachment) {
			attachments.push(attachment);
		} else {
			text += input.slice(candidate.start, candidate.end);
		}
		index = candidate.end;
	}
	text += input.slice(index);

	return {
		text: text.replace(/[ \t]+\n/g, "\n").trim(),
		images: [],
		attachments,
	};
}

async function resolveNativePromptAttachment(fileArg: string): Promise<AttachmentRecord | undefined> {
	const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

	try {
		const stats = await stat(absolutePath);
		if (!stats.isFile() || stats.size === 0) return undefined;

		// Text and image references retain stock interactive Pi semantics. Only
		// binary/native input types are promoted into the Hi-Fi attachment sidecar.
		if (await detectSupportedImageMimeTypeFromFile(absolutePath)) return undefined;
		const mediaType = await detectAttachmentMimeTypeFromFile(absolutePath);
		if (!mediaType) return undefined;

		return {
			id: `att_${randomUUID()}`,
			filename: basename(absolutePath),
			mediaType,
			sizeBytes: stats.size,
			source: { type: "path", path: absolutePath },
		};
	} catch {
		// A mention, missing path, unreadable file, or a path that changes while
		// resolving is ordinary prompt text and must never block submission.
		return undefined;
	}
}

function failFileProcessing(message: string, failureMode: "exit" | "throw"): never {
	if (failureMode === "throw") throw new Error(message);
	console.error(chalk.red(`Error: ${message}`));
	process.exit(1);
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const failureMode = options?.failureMode ?? "exit";
	let text = "";
	const images: ImageContent[] = [];
	const attachments: AttachmentRecord[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			failFileProcessing(`File not found: ${absolutePath}`, failureMode);
		}

		// Check if file is empty
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// Handle image file
			const content = await readFile(absolutePath);
			const processed = await processImage(content, mimeType, { autoResizeImages });

			if (!processed.ok) {
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: processed.data,
			};
			images.push(attachment);

			// Add text reference to image with optional processing hints
			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			const attachmentMimeType = await detectAttachmentMimeTypeFromFile(absolutePath);
			if (attachmentMimeType) {
				attachments.push({
					id: `att_${randomUUID()}`,
					filename: basename(absolutePath),
					mediaType: attachmentMimeType,
					sizeBytes: stats.size,
					source: { type: "path", path: absolutePath },
				});
			} else {
				// Preserve the existing inline behavior for UTF-8 text files.
				try {
					const content = await readFile(absolutePath, "utf-8");
					text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					failFileProcessing(`Could not read file ${absolutePath}: ${message}`, failureMode);
				}
			}
		}
	}

	return { text, images, attachments };
}
