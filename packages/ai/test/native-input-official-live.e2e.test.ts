import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { complete, getModels } from "../src/compat.ts";
import type { Api, AssistantMessage, AttachmentRecord, Context, Model, ProviderTraceEvent } from "../src/types.ts";

const LIVE_FLAG = "HIFI_PI_LIVE_NATIVE_INPUTS";
const liveEnabled = process.env[LIVE_FLAG] === "1";
const fixture = readFileSync(new URL("./fixtures/native-input/contract-sample.pdf", import.meta.url));
const fixtureBase64 = fixture.toString("base64");

function liveContext(provider: string): Context {
	const attachment: AttachmentRecord = {
		id: `att_live_${provider}`,
		filename: "contract-sample.pdf",
		mediaType: "application/pdf",
		sizeBytes: fixture.byteLength,
		source: { type: "base64", data: fixtureBase64 },
	};
	return {
		messages: [
			{
				role: "user",
				content: "Acknowledge that the attached contract fixture was received in one short sentence.",
				attachments: [{ type: "attachment", attachmentId: attachment.id }],
				timestamp: Date.now(),
			},
		],
		attachmentRegistry: { resolve: (id) => (id === attachment.id ? attachment : undefined) },
	};
}

function configuredModel(provider: "openai" | "anthropic" | "google", modelId: string): Model<Api> {
	const model = (getModels(provider) as Model<Api>[]).find((candidate) => candidate.id === modelId);
	if (!model) throw new Error(`Official live model is not present in the catalog: ${provider}/${modelId}`);
	return model;
}

function failureCategory(message: string): "authentication" | "capability" | "network" | "provider" {
	if (/401|403|api.?key|auth|credential|unauthorized|forbidden/i.test(message)) return "authentication";
	if (/unsupported|does not support|invalid.*(file|document|mime)|capabilit/i.test(message)) return "capability";
	if (/network|fetch|connect|timeout|dns|socket|econn|enotfound/i.test(message)) return "network";
	return "provider";
}

function assertOfficialLiveSuccess(
	provider: string,
	modelId: string,
	response: AssistantMessage,
	traces: ProviderTraceEvent[],
): void {
	if (response.stopReason === "error") {
		const message = response.errorMessage ?? "unknown provider error";
		throw new Error(`[official ${provider}/${modelId}] ${failureCategory(message)} failure: ${message}`);
	}
	const payloadTrace = traces.find((trace) => trace.stage === "sanitized_wire_payload");
	expect(payloadTrace, `missing sanitized trace for official ${provider}/${modelId}`).toBeDefined();
	const serializedTrace = JSON.stringify(payloadTrace);
	expect(serializedTrace).toContain("[redacted");
	expect(serializedTrace).not.toContain(fixtureBase64);
	expect(response.content.length).toBeGreaterThan(0);
}

describe.skipIf(!(liveEnabled && process.env.OPENAI_API_KEY))(
	`official OpenAI native PDF live E2E (requires ${LIVE_FLAG}=1 and OPENAI_API_KEY)`,
	() => {
		it("accepts the original PDF through OpenAI Responses", { timeout: 120_000, retry: 1 }, async () => {
			const modelId = process.env.HIFI_PI_OPENAI_NATIVE_INPUT_MODEL ?? "gpt-5.4-mini";
			const model = configuredModel("openai", modelId);
			const traces: ProviderTraceEvent[] = [];
			const response = await complete(model, liveContext("openai"), {
				apiKey: process.env.OPENAI_API_KEY,
				cacheRetention: "none",
				maxTokens: 128,
				onTrace: (event) => {
					traces.push(event);
				},
			});
			assertOfficialLiveSuccess("openai", modelId, response, traces);
		});
	},
);

describe.skipIf(!(liveEnabled && process.env.ANTHROPIC_API_KEY))(
	`official Anthropic native PDF live E2E (requires ${LIVE_FLAG}=1 and ANTHROPIC_API_KEY)`,
	() => {
		it("accepts the original PDF through Anthropic Messages", { timeout: 120_000, retry: 1 }, async () => {
			const modelId = process.env.HIFI_PI_ANTHROPIC_NATIVE_INPUT_MODEL ?? "claude-sonnet-4-6";
			const model = configuredModel("anthropic", modelId);
			const traces: ProviderTraceEvent[] = [];
			const response = await complete(model, liveContext("anthropic"), {
				apiKey: process.env.ANTHROPIC_API_KEY,
				cacheRetention: "none",
				maxTokens: 128,
				thinkingEnabled: false,
				onTrace: (event) => {
					traces.push(event);
				},
			});
			assertOfficialLiveSuccess("anthropic", modelId, response, traces);
		});
	},
);

describe.skipIf(!(liveEnabled && process.env.GEMINI_API_KEY))(
	`official Gemini native PDF live E2E (requires ${LIVE_FLAG}=1 and GEMINI_API_KEY)`,
	() => {
		it("accepts the original PDF through Generate Content", { timeout: 120_000, retry: 1 }, async () => {
			const modelId = process.env.HIFI_PI_GEMINI_NATIVE_INPUT_MODEL ?? "gemini-2.5-flash";
			const model = configuredModel("google", modelId);
			const traces: ProviderTraceEvent[] = [];
			const response = await complete(model, liveContext("google"), {
				apiKey: process.env.GEMINI_API_KEY,
				maxTokens: 128,
				onTrace: (event) => {
					traces.push(event);
				},
			});
			assertOfficialLiveSuccess("google", modelId, response, traces);
		});
	},
);
