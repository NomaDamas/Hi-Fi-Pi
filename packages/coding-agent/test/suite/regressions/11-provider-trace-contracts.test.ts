import type { ProviderTraceEvent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createTrace(harness: Harness): ProviderTraceEvent {
	const model = harness.getModel();
	return {
		type: "provider_trace",
		traceId: "provider_trace_test",
		sequence: 0,
		timestamp: 1,
		stage: "sanitized_wire_payload",
		provider: model.provider,
		api: model.api,
		modelId: model.id,
		endpointProfile: "test-profile",
		attachment: {
			id: "att_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
		},
		wire: { kind: "input_file", source: "inline" },
		payload: {
			input: [{ type: "input_file", file_data: "[redacted binary data]" }],
		},
	};
}

describe("Issue 11 provider trace public contracts", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("bridges sanitized trace events to AgentSession, extensions, and RPC-serializable events", async () => {
		const extensionEvents: ProviderTraceEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("provider_trace", (event) => {
						extensionEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		const trace = createTrace(harness);

		await harness.session.agent.onTrace?.(trace, harness.getModel());

		expect(harness.eventsOfType("provider_trace")).toEqual([trace]);
		expect(extensionEvents).toEqual([trace]);
		expect(JSON.parse(JSON.stringify(harness.eventsOfType("provider_trace")[0]))).toEqual(trace);
	});

	it("returns defensive copies from the programmatic trace history", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const trace = createTrace(harness);
		await harness.session.agent.onTrace?.(trace, harness.getModel());

		const history = harness.session.getProviderTraceEvents();
		history[0].traceId = "mutated";

		expect(harness.session.getLatestProviderTrace()?.traceId).toBe("provider_trace_test");
	});
});
