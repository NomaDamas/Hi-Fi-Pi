import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzureResponses } from "../src/api/azure-openai-responses.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type {
	AssistantMessageEventStream,
	AttachmentRecord,
	Context,
	FetchFunction,
	KnownApi,
	Model,
} from "../src/types.ts";

const SECRET_BYTES = Buffer.from("fail-closed-fixture-bytes").toString("base64");
const MEDIA_TYPE = "application/x-hifi-unsupported";

const record: AttachmentRecord = {
	id: "att_contract",
	filename: "unsupported-fixture.bin",
	mediaType: MEDIA_TYPE,
	sizeBytes: Buffer.from(SECRET_BYTES, "base64").byteLength,
	source: { type: "base64", data: SECRET_BYTES },
};

type TransportStream = (model: Model<never>, context: Context, options?: never) => AssistantMessageEventStream;

interface TransportCase {
	api: KnownApi;
	provider: string;
	baseUrl: string;
	stream: TransportStream;
	/** Codex authenticates from a JWT before it builds the request body. */
	apiKey?: string;
	/** The Google adapters reject an injected fetch; they never reach one here. */
	supportsCustomFetch?: boolean;
}

const CODEX_TOKEN = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.signature`;

// Every transport registered in `BUILTIN_APIS`. A new api must be added here, or
// the registry coverage assertion below fails.
const TRANSPORTS: TransportCase[] = [
	{
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		stream: streamAnthropic as TransportStream,
	},
	{
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		stream: streamCompletions as TransportStream,
	},
	{
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		stream: streamResponses as TransportStream,
	},
	{
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		stream: streamCodexResponses as TransportStream,
		apiKey: CODEX_TOKEN,
	},
	{
		api: "azure-openai-responses",
		provider: "azure-openai-responses",
		baseUrl: "https://example.openai.azure.com/openai/v1",
		stream: streamAzureResponses as TransportStream,
	},
	{
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com",
		stream: streamGoogle as TransportStream,
		supportsCustomFetch: false,
	},
	{
		api: "google-vertex",
		provider: "google-vertex",
		baseUrl: "https://us-central1-aiplatform.googleapis.com",
		stream: streamVertex as TransportStream,
		supportsCustomFetch: false,
	},
	{
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://api.mistral.ai/v1",
		stream: streamMistral as TransportStream,
	},
	{
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		stream: streamBedrock as TransportStream,
	},
	{
		api: "pi-messages",
		provider: "pi",
		baseUrl: "https://gateway.example/pi",
		stream: streamPiMessages as TransportStream,
	},
];

function modelFor(transport: TransportCase): Model<never> {
	return {
		id: "fail-closed-model",
		name: "Fail closed model",
		api: transport.api,
		provider: transport.provider,
		baseUrl: transport.baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} as unknown as Model<never>;
}

function contextWith(messages: Context["messages"]): Context {
	return { messages, attachmentRegistry: { resolve: (id) => (id === record.id ? record : undefined) } };
}

const userAttachmentContext = contextWith([
	{
		role: "user",
		content: "Summarize the attached contract.",
		attachments: [{ type: "attachment", attachmentId: record.id }],
		timestamp: 1_700_000_000_000,
	},
]);

const toolResultAttachmentContext = contextWith([
	{ role: "user", content: "Read the file.", timestamp: 1_700_000_000_000 },
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fail-closed-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1_700_000_000_000,
	},
	{
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text", text: "attached" }],
		isError: false,
		attachments: [{ type: "attachment", attachmentId: record.id }],
		timestamp: 1_700_000_000_000,
	},
] as unknown as Context["messages"]);

async function runTransport(transport: TransportCase, context: Context) {
	let fetchCalls = 0;
	const fetchNever: FetchFunction = async () => {
		fetchCalls += 1;
		throw new Error("network must not be reached for an unsupported attachment");
	};
	const message = await transport
		.stream(modelFor(transport), context, {
			apiKey: transport.apiKey ?? "test-key",
			...(transport.supportsCustomFetch === false ? {} : { fetch: fetchNever }),
		} as never)
		.result();
	return { fetchCalls, message };
}

describe("transport attachment fail-closed contract", () => {
	for (const transport of TRANSPORTS) {
		it(`${transport.api} rejects user attachments before network execution`, async () => {
			const { fetchCalls, message } = await runTransport(transport, userAttachmentContext);

			expect(fetchCalls).toBe(0);
			expect(message.stopReason).toBe("error");
			const diagnostic = message.errorMessage ?? "";
			expect(diagnostic).toContain(transport.provider);
			expect(diagnostic).toContain(transport.api);
			expect(diagnostic).toContain(MEDIA_TYPE);
			expect(diagnostic).not.toContain(SECRET_BYTES);
			expect(diagnostic).not.toContain(SECRET_BYTES);
		});

		it(`${transport.api} rejects tool-result attachments before network execution`, async () => {
			const { fetchCalls, message } = await runTransport(transport, toolResultAttachmentContext);

			expect(fetchCalls).toBe(0);
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage ?? "").toContain(MEDIA_TYPE);
		});
	}

	it("covers every registered builtin api", async () => {
		const compat = await import("../src/compat.ts");
		compat.registerBuiltInApiProviders();
		const covered = TRANSPORTS.map((transport) => transport.api);

		for (const provider of compat.getApiProviders()) {
			expect(covered).toContain(provider.api);
		}
	});
});
