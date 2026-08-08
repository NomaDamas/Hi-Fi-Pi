import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { sanitizeProviderPayloadForTrace } from "../src/api/attachment-lowering.ts";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { AttachmentRecord, Context, Model } from "../src/types.ts";

const FIXTURE_URL = new URL("./fixtures/native-input/contract-sample.pdf", import.meta.url);
const SECOND_FIXTURE_URL = new URL("./fixtures/native-input/contract-sample-2.pdf", import.meta.url);
const GOLDEN_URL = new URL("./fixtures/native-input/provider-payload-golden.json", import.meta.url);
const PROMPT = "Analyze the contract fixture.";

type ContractApi = "openai-responses" | "anthropic-messages" | "google-generative-ai";

function makeModel<TApi extends ContractApi>(api: TApi, provider: string, id: string): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl:
			api === "openai-responses"
				? "https://api.openai.com/v1"
				: api === "anthropic-messages"
					? "https://api.anthropic.com"
					: "https://generativelanguage.googleapis.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function fixtureRecord(id: string, filename: string, source: AttachmentRecord["source"]): AttachmentRecord {
	return {
		id,
		filename,
		mediaType: "application/pdf",
		sizeBytes:
			source.type === "base64"
				? Buffer.from(source.data, "base64").byteLength
				: readFileSync(filename === "contract-sample-2.pdf" ? SECOND_FIXTURE_URL : FIXTURE_URL).byteLength,
		source,
	};
}

function base64Record(id = "att_contract", filename = "contract-sample.pdf"): AttachmentRecord {
	const fixture = readFileSync(filename === "contract-sample-2.pdf" ? SECOND_FIXTURE_URL : FIXTURE_URL);
	return fixtureRecord(id, filename, { type: "base64", data: fixture.toString("base64") });
}

function contextFor(records: AttachmentRecord[], text = PROMPT): Context {
	const byId = new Map(records.map((record) => [record.id, record]));
	return {
		messages: [
			{
				role: "user",
				content: text,
				attachments: records.map((record) => ({ type: "attachment" as const, attachmentId: record.id })),
				timestamp: 1_700_000_000_000,
			},
		],
		attachmentRegistry: { resolve: (id) => byId.get(id) },
	};
}

async function anthropicMessages(context: Context): Promise<unknown> {
	let payload: unknown;
	const model = makeModel("anthropic-messages", "anthropic", "claude-sonnet-4-6");
	const result = streamAnthropic(model, context, {
		apiKey: "contract-key",
		cacheRetention: "none",
		onPayload: (value) => {
			payload = value;
			throw new Error("contract payload captured");
		},
	});
	await result.result();
	return (payload as { messages: unknown }).messages;
}

async function anthropicProviderFileHeaders(context: Context): Promise<Record<string, string>> {
	let headers = new Headers();
	const model = makeModel("anthropic-messages", "anthropic", "claude-sonnet-4-6");
	const result = streamAnthropic(model, context, {
		apiKey: "contract-key",
		cacheRetention: "none",
		fetch: async (input, init) => {
			headers = input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers);
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		},
	});
	await result.result();
	return { "anthropic-beta": headers.get("anthropic-beta") ?? "" };
}

describe("official native-input provider contract matrix", () => {
	it("matches exact sanitized golden payload fragments and provenance", async () => {
		const first = base64Record();
		const second = base64Record("att_contract_2", "contract-sample-2.pdf");
		const openaiModel = makeModel("openai-responses", "openai", "gpt-5-mini");
		const googleModel = makeModel("google-generative-ai", "google", "gemini-2.5-flash");
		const openaiProviderFile = fixtureRecord("att_contract", "contract-sample.pdf", {
			type: "provider-file",
			provider: "openai",
			fileId: "file_contract_123",
		});
		const anthropicProviderFile = fixtureRecord("att_contract", "contract-sample.pdf", {
			type: "provider-file",
			provider: "anthropic",
			fileId: "file_contract_123",
		});
		const googleProviderFile = fixtureRecord("att_contract", "contract-sample.pdf", {
			type: "provider-file",
			provider: "google",
			fileId: "files/contract-123",
			uri: "https://generativelanguage.googleapis.com/v1beta/files/contract-123",
		});
		const urlRecord = fixtureRecord("att_contract", "contract-sample.pdf", {
			type: "url",
			url: "https://example.com/contract-sample.pdf",
		});

		const actual = {
			schemaVersion: 1,
			verifiedAt: "2026-08-07",
			payloadScope: "provider request message/content fragments after sanitization",
			providers: {
				"openai-responses": {
					provenance: "https://developers.openai.com/api/docs/guides/file-inputs",
					inline: sanitizeProviderPayloadForTrace(
						convertResponsesMessages(openaiModel, contextFor([first]), new Set(["openai"])),
					),
					providerFile: sanitizeProviderPayloadForTrace(
						convertResponsesMessages(openaiModel, contextFor([openaiProviderFile]), new Set(["openai"])),
					),
					url: sanitizeProviderPayloadForTrace(
						convertResponsesMessages(openaiModel, contextFor([urlRecord]), new Set(["openai"])),
					),
				},
				"anthropic-messages": {
					provenance: "https://platform.claude.com/docs/en/build-with-claude/pdf-support",
					inline: sanitizeProviderPayloadForTrace(await anthropicMessages(contextFor([first]))),
					providerFile: sanitizeProviderPayloadForTrace(
						await anthropicMessages(contextFor([anthropicProviderFile])),
					),
					providerFileHeaders: await anthropicProviderFileHeaders(contextFor([anthropicProviderFile])),
					url: sanitizeProviderPayloadForTrace(await anthropicMessages(contextFor([urlRecord]))),
				},
				"google-generative-ai": {
					provenance: "https://ai.google.dev/gemini-api/docs/document-processing",
					inline: sanitizeProviderPayloadForTrace(convertGoogleMessages(googleModel, contextFor([first]))),
					providerFile: sanitizeProviderPayloadForTrace(
						convertGoogleMessages(googleModel, contextFor([googleProviderFile])),
					),
					multiple: sanitizeProviderPayloadForTrace(
						convertGoogleMessages(
							googleModel,
							contextFor([first, second], "Compare the contract fixtures in attachment order."),
						),
					),
				},
			},
		};

		expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN_URL, "utf8")));
	});

	it("proves every inline encoding decodes to the original fixture bytes", async () => {
		const original = readFileSync(FIXTURE_URL);
		const record = base64Record();
		const openai = convertResponsesMessages(
			makeModel("openai-responses", "openai", "gpt-5-mini"),
			contextFor([record]),
			new Set(["openai"]),
		) as unknown as Array<{ content: Array<{ type: string; file_data?: string }> }>;
		const anthropic = (await anthropicMessages(contextFor([record]))) as Array<{
			content: Array<{ type: string; source?: { data?: string } }>;
		}>;
		const google = convertGoogleMessages(
			makeModel("google-generative-ai", "google", "gemini-2.5-flash"),
			contextFor([record]),
		) as Array<{ parts: Array<{ inlineData?: { data?: string } }> }>;

		const openaiData = openai[0]?.content.find((part) => part.type === "input_file")?.file_data;
		const anthropicData = anthropic[0]?.content.find((part) => part.type === "document")?.source?.data;
		const googleData = google[0]?.parts.find((part) => part.inlineData)?.inlineData?.data;
		expect(Buffer.from(openaiData?.split(",")[1] ?? "", "base64")).toEqual(original);
		expect(Buffer.from(anthropicData ?? "", "base64")).toEqual(original);
		expect(Buffer.from(googleData ?? "", "base64")).toEqual(original);
	});
});
