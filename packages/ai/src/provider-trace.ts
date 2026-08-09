import type {
	Api,
	AssistantMessage,
	Model,
	ProviderHeaders,
	ProviderResponse,
	ProviderTraceCallback,
	ProviderTraceEvent,
} from "./types.ts";

export type ProviderTraceDraft = Omit<
	ProviderTraceEvent,
	"api" | "modelId" | "provider" | "sequence" | "timestamp" | "traceId" | "type"
>;

let nextTraceId = 0;

function isSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase().replaceAll("-", "_");
	return (
		(normalized.startsWith("x_amz_") && /(?:authorization|credential|security_token|signature)$/.test(normalized)) ||
		normalized === "authorization" ||
		normalized === "proxy_authorization" ||
		normalized === "cookie" ||
		normalized === "set_cookie" ||
		normalized === "api_key" ||
		normalized === "apikey" ||
		normalized === "x_api_key" ||
		normalized === "access_token" ||
		normalized === "refresh_token" ||
		normalized === "client_secret" ||
		normalized === "password" ||
		normalized === "secret" ||
		normalized === "token"
	);
}

function isSignedQueryParameter(key: string): boolean {
	return /(?:^|[-_])(signature|credential|token|api[-_]?key|secret)(?:$|[-_])/i.test(key);
}

function sanitizeUrl(value: string): string {
	if (!/^https?:\/\//i.test(value)) return value;
	try {
		const url = new URL(value);
		for (const key of [...url.searchParams.keys()]) {
			if (isSignedQueryParameter(key)) url.searchParams.set(key, "[redacted]");
		}
		return url.toString();
	} catch {
		return value;
	}
}

function isInlineData(key: string, value: string): boolean {
	const normalized = key.toLowerCase().replaceAll("-", "_");
	return (
		normalized === "file_data" ||
		(normalized === "data" && (value.startsWith("data:") || /^[A-Za-z0-9+/]+={0,2}$/.test(value)))
	);
}

export function sanitizeProviderTraceValue(value: unknown, key = ""): unknown {
	if (isSensitiveKey(key)) return "[redacted]";
	if (value instanceof Uint8Array) return `[redacted inline bytes: ${value.byteLength} bytes]`;
	if (Array.isArray(value)) return value.map((item) => sanitizeProviderTraceValue(item));
	if (typeof value === "string") {
		if (isInlineData(key, value)) return `[redacted ${value.length} chars]`;
		return sanitizeUrl(value);
	}
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([entryKey, entryValue]) => [
			entryKey,
			sanitizeProviderTraceValue(entryValue, entryKey),
		]),
	);
}

export function sanitizeProviderHeadersForTrace(
	headers: ProviderHeaders | Headers | Record<string, string> | undefined,
): Record<string, string> {
	if (!headers) return {};
	const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
	return Object.fromEntries(
		entries
			.filter((entry): entry is [string, string] => entry[1] !== null)
			.map(([key, value]) => [key.toLowerCase(), String(sanitizeProviderTraceValue(value, key))]),
	);
}

export class ProviderTraceRecorder {
	readonly traceId: string;
	private sequence = 0;
	private pending: ProviderTraceEvent[] = [];
	private readonly model: Model<Api>;

	constructor(model: Model<Api>) {
		this.model = model;
		nextTraceId += 1;
		this.traceId = `provider_trace_${Date.now().toString(36)}_${nextTraceId.toString(36)}`;
	}

	record(draft: ProviderTraceDraft): ProviderTraceEvent {
		const event: ProviderTraceEvent = {
			type: "provider_trace",
			traceId: this.traceId,
			sequence: this.sequence,
			timestamp: Date.now(),
			provider: this.model.provider,
			api: this.model.api,
			modelId: this.model.id,
			...draft,
		};
		this.sequence += 1;
		this.pending.push(event);
		return event;
	}

	snapshot(): ProviderTraceEvent[] {
		return this.pending.map((event) => structuredClone(event));
	}

	async flush(callback: ProviderTraceCallback | undefined): Promise<void> {
		const events = this.pending;
		this.pending = [];
		if (!callback) return;
		for (const event of events) {
			try {
				await callback(event, this.model);
			} catch {
				// Trace observers are non-mutating diagnostics and must never break provider execution.
			}
		}
	}

	async emit(draft: ProviderTraceDraft, callback: ProviderTraceCallback | undefined): Promise<void> {
		this.record(draft);
		await this.flush(callback);
	}
}

export function createProviderTraceRecorder(
	model: Model<Api>,
	callback: ProviderTraceCallback | undefined,
): ProviderTraceRecorder | undefined {
	return callback ? new ProviderTraceRecorder(model) : undefined;
}

export async function traceRequestHeaders(
	recorder: ProviderTraceRecorder | undefined,
	callback: ProviderTraceCallback | undefined,
	headers: ProviderHeaders | undefined,
): Promise<void> {
	if (!recorder) return;
	await recorder.emit({ stage: "request_headers", headers: sanitizeProviderHeadersForTrace(headers) }, callback);
}

export async function traceProviderOptions(
	recorder: ProviderTraceRecorder | undefined,
	callback: ProviderTraceCallback | undefined,
	options: Record<string, unknown> | undefined,
): Promise<void> {
	if (!recorder || !options) return;
	await recorder.emit(
		{ stage: "provider_options", options: sanitizeProviderTraceValue(options) as Record<string, unknown> },
		callback,
	);
}

export async function traceProviderPayload(
	recorder: ProviderTraceRecorder | undefined,
	callback: ProviderTraceCallback | undefined,
	payload: unknown,
): Promise<void> {
	if (!recorder) return;
	await recorder.emit({ stage: "sanitized_wire_payload", payload: sanitizeProviderTraceValue(payload) }, callback);
}

export async function traceProviderResponse(
	recorder: ProviderTraceRecorder | undefined,
	callback: ProviderTraceCallback | undefined,
	response: ProviderResponse,
): Promise<void> {
	if (!recorder) return;
	await recorder.emit(
		{
			stage: "response_metadata",
			response: {
				status: response.status,
				headers: sanitizeProviderHeadersForTrace(response.headers),
			},
		},
		callback,
	);
}

export async function traceProviderCompletion(
	recorder: ProviderTraceRecorder | undefined,
	callback: ProviderTraceCallback | undefined,
	message: AssistantMessage,
): Promise<void> {
	if (!recorder) return;
	const stateIdentifiers = message.content.flatMap((content) => {
		if (content.type === "toolCall" && content.thoughtSignature) return ["toolCall.thoughtSignature"];
		if (content.type === "thinking" && content.thinkingSignature) return ["thinking.thinkingSignature"];
		return [];
	});
	await recorder.emit(
		{
			stage: "stream_completion",
			completion: {
				...(message.responseId ? { responseId: message.responseId } : {}),
				stopReason: message.stopReason,
				usage: structuredClone(message.usage),
				...(stateIdentifiers.length > 0 ? { stateIdentifiers } : {}),
			},
			...(message.errorMessage ? { error: message.errorMessage } : {}),
		},
		callback,
	);
}
