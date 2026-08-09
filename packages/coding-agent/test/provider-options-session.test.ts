import { getProviderOptionScope } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("AgentSession provider options", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("validates, persists, forwards, and restores model-scoped selections", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
			extensionFactories: [
				(pi) => {
					pi.registerProviderBackend({
						apiVersion: 1,
						id: "provider-options-session",
						match: { provider: "faux", api: /^faux(?::|$)/, baseUrl: "http://localhost:0" },
						options: [
							{
								key: "faux.temperature",
								type: "number",
								minimum: 0,
								maximum: 2,
								default: 1,
								description: "Faux sampling temperature.",
							},
						],
						prepareInput: () => ({ request: {} }),
						stream: () => {
							throw new Error("unused");
						},
					});
				},
			],
		});
		harnesses.push(harness);

		expect(harness.session.getProviderOptionDefinitions()).toEqual([
			expect.objectContaining({ key: "faux.temperature", default: 1 }),
		]);
		expect(harness.session.getEffectiveProviderOptions()).toEqual({ "faux.temperature": 1 });
		expect(() => harness.session.setProviderOption("faux.temperature", 3)).toThrow("must be at most 2");

		expect(harness.session.setProviderOption("faux.temperature", 0.25)).toEqual({
			"faux.temperature": 0.25,
		});
		expect(harness.session.getProviderOptionValues()).toEqual({ "faux.temperature": 0.25 });
		const scope = getProviderOptionScope(harness.getModel("faux-1")!);
		expect(harness.settingsManager.getProviderOptions(scope)).toEqual({ "faux.temperature": 0.25 });
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "hifi.provider-options"),
		).toHaveLength(1);

		let forwarded: Record<string, unknown> | undefined;
		harness.session.agent.streamFunction = (_model, _context, options) => {
			forwarded = options?.providerOptions;
			throw new Error("stop after option capture");
		};
		await harness.session.prompt("capture");
		expect(forwarded).toEqual({ "faux.temperature": 0.25 });

		await harness.session.setModel(harness.getModel("faux-2")!);
		expect(harness.session.getProviderOptionValues()).toEqual({});
		await harness.session.setModel(harness.getModel("faux-1")!);
		expect(harness.session.getProviderOptionValues()).toEqual({ "faux.temperature": 0.25 });
		expect(harness.session.unsetProviderOption("faux.temperature")).toEqual({ "faux.temperature": 1 });
		expect(harness.session.getProviderOptionValues()).toEqual({});
	});

	it("rejects secret-bearing SDK selections before a request", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerProviderBackend({
						apiVersion: 1,
						id: "provider-options-secret-test",
						match: { provider: "faux", api: /^faux(?::|$)/, baseUrl: "http://localhost:0" },
						options: [{ key: "faux.config", type: "structured", description: "Faux structured config." }],
						prepareInput: () => ({ request: {} }),
						stream: () => {
							throw new Error("unused");
						},
					});
				},
			],
		});
		harnesses.push(harness);

		expect(() => harness.session.setProviderOption("faux.config", { api_key: "secret" })).toThrow(
			"contains a secret-like field",
		);
		expect(harness.session.getProviderOptionValues()).toEqual({});
	});
});
