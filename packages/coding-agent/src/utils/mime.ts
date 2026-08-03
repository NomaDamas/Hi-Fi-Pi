import { open } from "node:fs/promises";
import { extname } from "node:path";

const IMAGE_TYPE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ATTACHMENT_MIME_TYPES = new Map<string, string>([
	[".pdf", "application/pdf"],
	[".doc", "application/msword"],
	[".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	[".ppt", "application/vnd.ms-powerpoint"],
	[".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
	[".xls", "application/vnd.ms-excel"],
	[".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	[".wav", "audio/wav"],
	[".mp3", "audio/mpeg"],
	[".m4a", "audio/mp4"],
	[".flac", "audio/flac"],
	[".ogg", "audio/ogg"],
	[".mp4", "video/mp4"],
	[".mov", "video/quicktime"],
	[".webm", "video/webm"],
]);

export function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWith(buffer, PNG_SIGNATURE)) {
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
		return "image/bmp";
	}
	return null;
}

export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
		return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}

export async function detectAttachmentMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
		const bytes = buffer.subarray(0, bytesRead);
		const sniffed = detectAttachmentMimeType(bytes);
		if (sniffed) return sniffed;

		const extensionMimeType = ATTACHMENT_MIME_TYPES.get(extname(filePath).toLowerCase());
		if (extensionMimeType) return extensionMimeType;
		return isProbablyText(bytes) ? null : "application/octet-stream";
	} finally {
		await fileHandle.close();
	}
}

function detectAttachmentMimeType(buffer: Uint8Array): string | null {
	if (startsWithAscii(buffer, 0, "%PDF-")) return "application/pdf";
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WAVE")) return "audio/wav";
	if (startsWithAscii(buffer, 0, "fLaC")) return "audio/flac";
	if (startsWithAscii(buffer, 0, "OggS")) return "audio/ogg";
	if (startsWithAscii(buffer, 4, "ftyp")) {
		return startsWithAscii(buffer, 8, "qt  ") ? "video/quicktime" : "video/mp4";
	}
	if (startsWithAscii(buffer, 0, "\x1aE\xdf\xa3")) return "video/webm";
	return null;
}

function isProbablyText(buffer: Uint8Array): boolean {
	if (buffer.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		return true;
	} catch {
		return false;
	}
}

function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;

		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

function isBmp(buffer: Uint8Array): boolean {
	if (buffer.length < 26) return false;

	const declaredFileSize = readUint32LE(buffer, 2);
	const pixelDataOffset = readUint32LE(buffer, 10);
	const dibHeaderSize = readUint32LE(buffer, 14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		return false;
	}

	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * 0x1000000
	);
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
