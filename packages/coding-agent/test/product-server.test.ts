import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_DEFINITION_SCHEMA_VERSION, AgentDefinitionRegistry } from "../src/agent-definition.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { ProductPolicyEnforcer } from "../src/product/policy.ts";
import { type ProductAgentEvent, ProductAgentServer, ProductAgentServerError } from "../src/product/server.ts";
import { FilesystemProductStorage, type ProductIdentity } from "../src/product/storage.ts";

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
	authorization: string | null;
}

function completedResponse(text: string): Response {
	const events = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: `msg_${text}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: `msg_${text}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: `resp_${text}`,
				status: "completed",
				output: [],
				usage: {
					input_tokens: 4,
					output_tokens: 2,
					total_tokens: 6,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream", "x-request-id": `req_${text}` },
	});
}

async function collectThroughDone(stream: AsyncIterator<ProductAgentEvent>): Promise<ProductAgentEvent[]> {
	const events: ProductAgentEvent[] = [];
	for (;;) {
		const next = await stream.next();
		if (next.done) return events;
		events.push(next.value);
		if (next.value.kind === "done") {
			await stream.return?.();
			return events;
		}
	}
}

describe("product agent server", () => {
	let directory: string;
	let storage: FilesystemProductStorage;
	let registry: AgentDefinitionRegistry;
	let server: ProductAgentServer;
	let captured: CapturedRequest[];
	let responseNumber: number;
	const research: ProductIdentity = {
		tenantId: "tenant-a",
		userId: "user-a",
		agentId: "research",
		threadId: "thread-a",
	};

	beforeEach(async () => {
		directory = join(tmpdir(), `hifi-product-server-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		storage = new FilesystemProductStorage({ root: join(directory, "product-state") });
		const auth = AuthStorage.inMemory();
		await auth.modify("openai", async () => ({ type: "api_key", key: "sk-test-secret-key" }));
		const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: join(directory, "models.json") });
		const model = getModel("openai", "gpt-5.4");
		runtime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		registry = new AgentDefinitionRegistry(runtime);
		for (const agentId of ["research", "coding"]) {
			registry.register(
				{
					schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
					id: agentId,
					version: "1.0.0",
					model: { provider: model.provider, modelId: model.id },
					systemPrompt: `Act as ${agentId}.`,
					tools: [],
				},
				{ baseDirectory: directory },
			);
		}
		server = new ProductAgentServer({
			storage,
			policy: new ProductPolicyEnforcer({
				policy: {
					attachments: {
						allowedLocalRoots: [storage.root],
						allowedHosts: ["files.example.com"],
						maximumBytes: 1_000_000,
						maximumCount: 4,
						maximumAggregateBytes: 2_000_000,
					},
				},
			}),
			authorizer: { authorize: () => true },
			registryForIdentity: () => registry,
		});
		captured = [];
		responseNumber = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			captured.push({
				url: request.url,
				body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
				authorization: request.headers.get("authorization"),
			});
			responseNumber += 1;
			return completedResponse(`answer-${responseNumber}`);
		});
	});

	afterEach(async () => {
		await server.dispose();
		vi.restoreAllMocks();
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	});

	it("sends uploaded PDF bytes through the OpenAI native input_file path and streams ordered events", async () => {
		await server.createSession(research, { cwd: directory });
		const bytes = new TextEncoder().encode("%PDF-1.4\nnative-product-input");
		const attachment = await server.uploadAttachment(research, {
			id: "att_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			bytes,
		});
		const stream = await server.events(research);
		await server.prompt(research, { text: "Analyze the paper", attachmentIds: [attachment.id] });
		const events = await collectThroughDone(stream);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://api.openai.com/v1/responses");
		const serializedPayload = JSON.stringify(captured[0]?.body);
		expect(serializedPayload).toContain('"type":"input_file"');
		expect(serializedPayload).toContain(`data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`);
		expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
		expect(events.map((event) => event.kind)).toEqual(
			expect.arrayContaining([
				"session_started",
				"attachment_ready",
				"input_accepted",
				"assistant_text",
				"assistant_message",
				"usage",
				"provider_trace",
				"done",
			]),
		);
		expect(events.findIndex((event) => event.kind === "input_accepted")).toBeLessThan(
			events.findIndex((event) => event.kind === "assistant_text"),
		);
		expect(JSON.stringify(events)).not.toContain(Buffer.from(bytes).toString("base64"));
		expect(JSON.stringify(await server.inspectTrace(research))).not.toContain("sk-test-secret-key");
	});

	it("keeps named agents and concurrent threads independent across disconnect and cancellation boundaries", async () => {
		const coding = { ...research, agentId: "coding", threadId: "thread-b" };
		await Promise.all([
			server.createSession(research, { cwd: directory }),
			server.createSession(coding, { cwd: directory }),
		]);
		const disconnected = await server.events(research);
		await disconnected.return();

		await Promise.all([server.prompt(research, { text: "research" }), server.prompt(coding, { text: "code" })]);
		const [researchInfo, codingInfo] = await Promise.all([server.getSession(research), server.getSession(coding)]);
		expect(researchInfo.agentDefinition.id).toBe("research");
		expect(codingInfo.agentDefinition.id).toBe("coding");
		expect(researchInfo.sessionId).not.toBe(codingInfo.sessionId);
		expect(captured).toHaveLength(2);
		await expect(server.abort(research)).resolves.toBeUndefined();
		expect((await server.getSession(coding)).agentDefinition.id).toBe("coding");
	});

	it("accepts validated provider-file and remote URL references without copying their contents", async () => {
		await server.createSession(research, { cwd: directory });
		const providerFile = await server.registerRemoteAttachment(research, {
			filename: "uploaded.pdf",
			mediaType: "application/pdf",
			sizeBytes: 20,
			source: {
				type: "provider-file",
				provider: "openai",
				api: "openai-responses",
				endpoint: "https://api.openai.com/v1",
				fileId: "file_owned",
			},
		});
		const remoteUrl = await server.registerRemoteAttachment(research, {
			filename: "remote.pdf",
			mediaType: "application/pdf",
			sizeBytes: 30,
			source: { type: "url", url: "https://files.example.com/remote.pdf" },
		});

		await server.prompt(research, {
			text: "Compare the files",
			attachmentIds: [providerFile.id, remoteUrl.id],
		});
		const payload = JSON.stringify(captured[0]?.body);
		expect(payload).toContain('"file_id":"file_owned"');
		expect(payload).toContain('"file_url":"https://files.example.com/remote.pdf"');
		expect(payload).not.toContain("file_data");
	});

	it("resumes a scoped thread and replays event history after reconnect", async () => {
		const created = await server.createSession(research, { cwd: directory });
		await server.prompt(research, { text: "persist this" });
		expect(created.sessionFile).toBeDefined();
		await server.closeSession(research);

		const resumed = await server.createSession(research, {
			cwd: directory,
			sessionFile: basename(created.sessionFile!),
		});
		expect(resumed.sessionId).toBe(created.sessionId);
		const reconnect = await server.events(research, { afterSequence: -1 });
		const first = await reconnect.next();
		expect(first.value?.kind).toBe("session_started");
		await reconnect.return();
	});

	it("requires host authorization and rejects cross-tenant or cross-provider attachment reuse", async () => {
		await server.createSession(research, { cwd: directory });
		const attachment = await server.uploadAttachment(research, {
			id: "att_private",
			filename: "private.pdf",
			mediaType: "application/pdf",
			bytes: new TextEncoder().encode("%PDF"),
		});
		const otherTenant = { ...research, tenantId: "tenant-b" };
		await server.createSession(otherTenant, { cwd: directory });
		await expect(server.prompt(otherTenant, { text: "steal", attachmentIds: [attachment.id] })).rejects.toThrow(
			"attachment_not_found",
		);
		await expect(
			server.registerRemoteAttachment(research, {
				filename: "foreign.pdf",
				mediaType: "application/pdf",
				sizeBytes: 10,
				source: { type: "provider-file", provider: "anthropic", fileId: "file_foreign" },
			}),
		).rejects.toThrow("belongs to anthropic");

		const denied = new ProductAgentServer({
			storage,
			policy: new ProductPolicyEnforcer(),
			authorizer: { authorize: () => false },
			registryForIdentity: () => registry,
		});
		await expect(denied.createSession({ ...research, threadId: "denied" }, { cwd: directory })).rejects.toThrow(
			ProductAgentServerError,
		);
		await denied.dispose();
	});

	it("disconnects slow subscribers at the configured backpressure boundary without closing the session", async () => {
		await server.dispose();
		server = new ProductAgentServer({
			storage,
			policy: new ProductPolicyEnforcer({ policy: { attachments: { allowedLocalRoots: [storage.root] } } }),
			authorizer: { authorize: () => true },
			registryForIdentity: () => registry,
			maximumSubscriberQueue: 1,
		});
		await server.createSession(research, { cwd: directory });
		await server.prompt(research, { text: "fill event history" });
		const stream = await server.events(research);
		await expect(stream.next()).rejects.toThrow("event_backpressure");
		expect((await server.getSession(research)).sessionId).toBeDefined();
	});
});
