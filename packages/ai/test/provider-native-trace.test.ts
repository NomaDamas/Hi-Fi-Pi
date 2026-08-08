import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamOpenAI } from "../src/api/openai-responses.ts";
import { sanitizeProviderHeadersForTrace, sanitizeProviderTraceValue } from "../src/provider-trace.ts";
import type { AttachmentRecord, AttachmentRegistry, Context, Model, ProviderTraceEvent } from "../src/types.ts";

const PDF_BASE64 = "JVBERi0xLjQKJcTl8uXrCg==";

function makeModel<TApi extends "openai-responses" | "anthropic-messages" | "google-generative-ai">(
	api: TApi,
	provider: string,
): Model<TApi> {
	const baseUrls = {
		"openai-responses": "https://api.openai.com/v1",
		"anthropic-messages": "https://api.anthropic.com",
		"google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
	};
	return {
		id: `${provider}-trace-model`,
		name: `${provider} Trace Model`,
		api,
		provider,
		baseUrl: baseUrls[api],
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function makeContext(): Context {
	const attachment: AttachmentRecord = {
		id: "att_pdf",
		filename: "paper.pdf",
		mediaType: "application/pdf",
		sizeBytes: 17,
		sha256: "fixture-sha256",
		source: { type: "base64", data: PDF_BASE64 },
	};
	const attachmentRegistry: AttachmentRegistry = {
		resolve: (id) => (id === attachment.id ? attachment : undefined),
	};
	return {
		messages: [
			{
				role: "user",
				content: "Summarize this PDF",
				attachments: [{ type: "attachment", attachmentId: attachment.id }],
				timestamp: 1_700_000_000_000,
			},
		],
		attachmentRegistry,
	};
}

describe("provider-native input tracing", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([
		{
			name: "OpenAI Responses",
			model: makeModel("openai-responses", "openai"),
			stream: streamOpenAI,
			wireKind: "input_file",
		},
		{
			name: "Anthropic Messages",
			model: makeModel("anthropic-messages", "anthropic"),
			stream: streamAnthropic,
			wireKind: "document",
		},
		{
			name: "Gemini generateContent",
			model: makeModel("google-generative-ai", "google"),
			stream: streamGoogle,
			wireKind: "inlineData",
		},
	])("records resolver through $name lowering without network execution", async ({ model, stream, wireKind }) => {
		const traces: ProviderTraceEvent[] = [];
		const result = stream(model as never, makeContext(), {
			apiKey: "test-key",
			onTrace: (event) => {
				traces.push(event);
			},
			onPayload: () => {
				throw new Error("stop before network");
			},
		});

		await result.result();

		expect(traces.slice(0, 4).map((trace) => trace.stage)).toEqual([
			"input_resolution",
			"capability_decision",
			"source_selection",
			"provider_lowering",
		]);
		expect(traces[0]).toMatchObject({
			provider: model.provider,
			api: model.api,
			modelId: model.id,
			attachment: {
				id: "att_pdf",
				filename: "paper.pdf",
				mediaType: "application/pdf",
				sizeBytes: 17,
				sha256: "fixture-sha256",
			},
		});
		expect(traces[1]).toMatchObject({
			capability: { supported: true, provenance: "official-default" },
			endpointProfile: expect.any(String),
		});
		expect(traces[2]).toMatchObject({ source: { form: "inline" } });
		expect(traces[3]).toMatchObject({ wire: { kind: wireKind, source: "inline" } });
		expect(JSON.stringify(traces).toLowerCase()).not.toMatch(/ocr|render pages|parser/);
	});

	it("redacts credentials, cookies, signed URL secrets, and inline bytes", () => {
		const sanitizedHeaders = sanitizeProviderHeadersForTrace({
			Authorization: "Bearer SECRET_AUTH",
			Cookie: "session=SECRET_COOKIE",
			"set-cookie": "session=SECRET_SET_COOKIE",
			"x-api-key": "SECRET_KEY",
			"x-request-id": "req_123",
		});
		const sanitizedPayload = sanitizeProviderTraceValue({
			api_key: "SECRET_BODY_KEY",
			access_token: "SECRET_TOKEN",
			file_data: `data:application/pdf;base64,${PDF_BASE64}`,
			inlineData: { mimeType: "application/pdf", data: PDF_BASE64 },
			file_url: "https://files.example/paper.pdf?X-Amz-Signature=SECRET_SIGNATURE&public=yes",
		});
		const serialized = JSON.stringify({ sanitizedHeaders, sanitizedPayload });

		expect(sanitizedHeaders).toMatchObject({
			authorization: "[redacted]",
			cookie: "[redacted]",
			"set-cookie": "[redacted]",
			"x-api-key": "[redacted]",
			"x-request-id": "req_123",
		});
		expect(sanitizedPayload).toMatchObject({
			api_key: "[redacted]",
			access_token: "[redacted]",
			file_data: expect.stringMatching(/^\[redacted \d+ chars\]$/),
			inlineData: { data: expect.stringMatching(/^\[redacted \d+ chars\]$/) },
		});
		expect(serialized).not.toContain("SECRET");
		expect(serialized).toContain("public=yes");
	});

	it("sanitizes configured capability headers and remote file URLs", async () => {
		const traces: ProviderTraceEvent[] = [];
		const context = makeContext();
		const attachment = context.attachmentRegistry?.resolve("att_pdf");
		if (!attachment) throw new Error("fixture attachment missing");
		attachment.remotes = {
			openai: {
				provider: "openai",
				api: "openai-responses",
				fileId: "file_123",
				uri: "https://files.example/paper.pdf?X-Amz-Signature=SECRET_REMOTE&public=yes",
				uploadedAt: 1,
			},
		};
		const model = makeModel("openai-responses", "openai");
		model.nativeInputs = {
			profile: "configured-trace-profile",
			capabilities: [
				{
					id: "pdf",
					supported: true,
					mediaTypes: ["application/pdf"],
					sources: ["provider-file"],
					wireKinds: { "provider-file": "input_file" },
					provenance: "configured",
					requiredHeaders: { Authorization: "Bearer SECRET_CAPABILITY", "x-beta": "files" },
				},
			],
		};
		const result = streamOpenAI(model, context, {
			apiKey: "test-key",
			onTrace: (event) => {
				traces.push(event);
			},
			onPayload: () => {
				throw new Error("stop before network");
			},
		});

		await result.result();

		const serialized = JSON.stringify(traces);
		expect(serialized).not.toContain("SECRET");
		expect(traces.find((trace) => trace.stage === "capability_decision")?.capability?.requiredHeaders).toEqual({
			authorization: "[redacted]",
			"x-beta": "files",
		});
		expect(traces.find((trace) => trace.stage === "remote_reuse")?.remote?.uri).toContain("public=yes");
	});

	it("emits sanitized wire, response, and completion records without changing raw hook timing", async () => {
		const order: string[] = [];
		const traces: ProviderTraceEvent[] = [];
		const encoder = new TextEncoder();
		const completedEvent = {
			type: "response.completed",
			sequence_number: 0,
			response: {
				id: "resp_trace_123",
				status: "completed",
				output: [],
				usage: {
					input_tokens: 20,
					output_tokens: 7,
					total_tokens: 27,
					input_tokens_details: { cached_tokens: 2 },
				},
			},
		};
		const fetchMock = vi.fn(async () => {
			order.push("fetch");
			return new Response(encoder.encode(`data: ${JSON.stringify(completedEvent)}\n\n`), {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-request-id": "req_trace_123",
					"set-cookie": "session=SECRET_RESPONSE_COOKIE",
				},
			});
		});
		const result = streamOpenAI(makeModel("openai-responses", "openai"), makeContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			headers: {
				Authorization: "Bearer SECRET_REQUEST_AUTH",
				"x-request-id": "req_client_123",
			},
			onPayload: (payload) => {
				order.push("before_provider_request");
				return payload;
			},
			onResponse: () => {
				order.push("after_provider_response");
			},
			onTrace: (event) => {
				traces.push(event);
				if (event.stage === "sanitized_wire_payload") order.push("safe_payload_trace");
				if (event.stage === "response_metadata") order.push("safe_response_trace");
			},
		});

		const output = await result.result();

		expect(output.stopReason).toBe("stop");
		expect(order).toEqual([
			"before_provider_request",
			"safe_payload_trace",
			"fetch",
			"after_provider_response",
			"safe_response_trace",
		]);
		expect(traces.find((trace) => trace.stage === "request_headers")?.headers).toMatchObject({
			authorization: "[redacted]",
			"x-request-id": "req_client_123",
		});
		expect(traces.find((trace) => trace.stage === "response_metadata")).toMatchObject({
			response: { status: 200, headers: { "set-cookie": "[redacted]", "x-request-id": "req_trace_123" } },
		});
		expect(traces.find((trace) => trace.stage === "stream_completion")).toMatchObject({
			completion: {
				responseId: "resp_trace_123",
				stopReason: "stop",
				usage: { input: 18, output: 7, cacheRead: 2, totalTokens: 27 },
			},
		});
		const wireTrace = traces.find((trace) => trace.stage === "sanitized_wire_payload");
		expect(JSON.stringify(wireTrace)).not.toContain(PDF_BASE64);
		expect(JSON.stringify(traces)).not.toContain("SECRET");
	});
});
