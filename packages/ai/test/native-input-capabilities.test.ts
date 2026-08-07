import { afterEach, describe, expect, it } from "vitest";
import {
	getNativeInputCapabilities,
	getNativeInputCapabilityManifest,
	registerNativeInputCapabilityResolver,
	resolveNativeInputCapability,
} from "../src/native-input-capabilities.ts";
import type { Api, Model, NativeInputCapabilityResolver } from "../src/types.ts";

function makeModel(provider: string, api: Api, baseUrl: string, id = `${provider}-test-model`): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

const unregisterCallbacks: Array<() => void> = [];

afterEach(() => {
	for (const unregister of unregisterCallbacks.splice(0)) unregister();
});

describe("provider-declared native input capabilities", () => {
	it.each([
		{
			model: makeModel("openai", "openai-responses", "https://api.openai.com/v1"),
			source: "inline" as const,
			wireKind: "input_file",
			profile: "openai-official",
		},
		{
			model: makeModel("anthropic", "anthropic-messages", "https://api.anthropic.com"),
			source: "inline" as const,
			wireKind: "document",
			profile: "anthropic-official",
		},
		{
			model: makeModel("google", "google-generative-ai", "https://generativelanguage.googleapis.com"),
			source: "inline" as const,
			wireKind: "inlineData",
			profile: "gemini-developer-api",
		},
	])("resolves official $profile PDF facts", ({ model, source, wireKind, profile }) => {
		const capability = resolveNativeInputCapability(model, "application/pdf", source);

		expect(capability).toMatchObject({
			supported: true,
			mediaType: "application/pdf",
			source,
			wireKind,
			endpointProfile: profile,
			provenance: "official-default",
		});
		expect(capability.sources).toContain(source);
		expect(capability.limits?.maximumBytes).toBeGreaterThan(0);
		expect(capability.verifiedAt).toBe("2026-08-07");
	});

	it("resolves source-specific Gemini and Anthropic transport facts", () => {
		const gemini = makeModel("google", "google-generative-ai", "https://generativelanguage.googleapis.com");
		const anthropic = makeModel("anthropic", "anthropic-messages", "https://api.anthropic.com");

		expect(resolveNativeInputCapability(gemini, "application/pdf", "provider-file")).toMatchObject({
			wireKind: "fileData",
		});
		expect(resolveNativeInputCapability(anthropic, "application/pdf", "provider-file")).toMatchObject({
			wireKind: "document",
			limits: { maximumBytes: 500 * 1024 * 1024 },
			requiredHeaders: { "anthropic-beta": "files-api-2025-04-14" },
		});
		expect(getNativeInputCapabilityManifest(gemini)).toMatchObject({
			endpointProfile: "gemini-developer-api",
			resolverId: "gemini-developer-api",
		});
	});

	it("does not grant official capabilities to an unknown compatible endpoint", () => {
		const model = makeModel("myproxy", "openai-responses", "https://proxy.example.com/v1");

		expect(resolveNativeInputCapability(model, "application/pdf", "inline")).toMatchObject({
			supported: false,
			reason: expect.stringMatching(/explicit native input capability opt-in/i),
		});
	});

	it("supports an additive configured manifest for arbitrary MIME types", () => {
		const model: Model<Api> = {
			...makeModel("myproxy", "openai-responses", "https://proxy.example.com/v1"),
			nativeInputs: {
				profile: "myproxy-files-v1",
				capabilities: [
					{
						id: "office-files",
						supported: true,
						mediaTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
						sources: ["inline", "provider-file"],
						wireKinds: { inline: "input_file", "provider-file": "input_file" },
						limits: { maximumBytes: 10_000_000, maximumCount: 4 },
						provenance: "configured",
					},
				],
			},
		};

		expect(
			resolveNativeInputCapability(
				model,
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				"inline",
			),
		).toMatchObject({
			supported: true,
			capabilityId: "office-files",
			wireKind: "input_file",
			endpointProfile: "myproxy-files-v1",
			limits: { maximumBytes: 10_000_000, maximumCount: 4 },
			provenance: "configured",
		});
	});

	it("supports registered provider resolvers without extending core MIME unions", () => {
		const resolver: NativeInputCapabilityResolver = {
			id: "acme-audio",
			matches: (context) => context.provider === "acme" && context.api === "openai-responses",
			resolve: () => ({
				profile: "acme-audio-v1",
				capabilities: [
					{
						id: "native-audio",
						supported: true,
						mediaTypes: ["audio/x-acme"],
						sources: ["inline"],
						wireKinds: { inline: "input_audio" },
						provenance: "configured",
					},
				],
			}),
		};
		unregisterCallbacks.push(registerNativeInputCapabilityResolver(resolver));
		const model = makeModel("acme", "openai-responses", "https://api.acme.example/v1");

		expect(resolveNativeInputCapability(model, "audio/x-acme", "inline")).toMatchObject({
			supported: true,
			wireKind: "input_audio",
			resolverId: "acme-audio",
		});
		expect(getNativeInputCapabilities(model).map((capability) => capability.id)).toContain("native-audio");
	});

	it("honors model allow and deny constraints", () => {
		const resolver: NativeInputCapabilityResolver = {
			id: "model-scoped",
			matches: (context) => context.provider === "scoped",
			resolve: () => ({
				profile: "scoped-v1",
				capabilities: [
					{
						id: "pdf",
						supported: true,
						mediaTypes: ["application/pdf"],
						sources: ["inline"],
						wireKinds: { inline: "document" },
						modelAllowList: ["scoped-pro-*"],
						modelDenyList: ["*-legacy"],
						provenance: "configured",
					},
				],
			}),
		};
		unregisterCallbacks.push(registerNativeInputCapabilityResolver(resolver));

		expect(
			resolveNativeInputCapability(
				makeModel("scoped", "anthropic-messages", "https://scoped.example", "scoped-pro-1"),
				"application/pdf",
				"inline",
			).supported,
		).toBe(true);
		expect(
			resolveNativeInputCapability(
				makeModel("scoped", "anthropic-messages", "https://scoped.example", "scoped-basic"),
				"application/pdf",
				"inline",
			).supported,
		).toBe(false);
		expect(
			resolveNativeInputCapability(
				makeModel("scoped", "anthropic-messages", "https://scoped.example", "scoped-pro-legacy"),
				"application/pdf",
				"inline",
			).supported,
		).toBe(false);
	});

	it("rejects a declared source without a wire representation", () => {
		const model: Model<Api> = {
			...makeModel("broken", "openai-responses", "https://broken.example/v1"),
			nativeInputs: {
				profile: "broken-v1",
				capabilities: [
					{
						id: "missing-wire-kind",
						supported: true,
						mediaTypes: ["application/pdf"],
						sources: ["inline"],
						wireKinds: {},
						provenance: "configured",
					},
				],
			},
		};

		expect(resolveNativeInputCapability(model, "application/pdf", "inline")).toMatchObject({
			supported: false,
			reason: "inline source has no declared wire kind",
		});
	});

	it("reports only transport facts rather than vendor-internal parsing claims", () => {
		const model = makeModel("google", "google-generative-ai", "https://generativelanguage.googleapis.com");
		const serialized = JSON.stringify(getNativeInputCapabilities(model)).toLowerCase();

		expect(serialized).not.toContain("ocr");
		expect(serialized).not.toContain("parser");
		expect(serialized).not.toContain("render pages");
	});
});
