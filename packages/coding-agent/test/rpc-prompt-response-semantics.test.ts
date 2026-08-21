import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AttachmentRecord,
	type Context,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	tools?: AgentTool[];
	responses?: AssistantMessage[];
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const responses = [...(options.responses ?? [])];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: options.tools ?? [],
		},
		streamFn: (_model, context, _options) => {
			testContextCapture.current?.(context);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					const message = responses.shift() ?? createAssistantMessage("done");
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						stream.push({ type: "error", reason: message.stopReason, error: message });
					} else {
						stream.push({
							type: "done",
							reason: message.stopReason === "pending" ? "stop" : message.stopReason,
							message,
						});
					}
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
		...(options.tools?.length
			? {
					baseToolsOverride: Object.fromEntries(options.tools.map((tool) => [tool.name, tool])),
					initialActiveToolNames: options.tools.map((tool) => tool.name),
				}
			: {}),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

const testContextCapture: { current?: (context: Context) => void } = {};

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	tools?: AgentTool[];
	responses?: AssistantMessage[];
}): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		testContextCapture.current = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("returns structured portability details when prompt preflight requires confirmation", async () => {
		const attachment: AttachmentRecord = {
			id: "att_rpc_unsupported_video",
			filename: "unsupported.mp4",
			mediaType: "video/mp4",
			source: { type: "base64", data: "AAAAIGZ0eXA=" },
		};
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(
				JSON.stringify({
					id: "portability-preflight",
					type: "prompt",
					message: "analyze",
					attachments: [attachment],
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "portability-preflight");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					success: false,
					details: {
						kind: "portability_confirmation_required",
						report: {
							items: [expect.objectContaining({ attachmentId: attachment.id })],
						},
					},
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("streams a structured portability error when an incompatible attachment appears mid-run", async () => {
		const generatedVideo: AttachmentRecord = {
			id: "att_rpc_tool_video",
			filename: "generated.mp4",
			mediaType: "video/mp4",
			source: { type: "base64", data: "AAAAIGZ0eXA=" },
		};
		const tool: AgentTool = {
			name: "make_video",
			label: "Make video",
			description: "Create a video attachment",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "created" }],
				details: {},
				attachments: [generatedVideo],
			}),
		};
		const toolCallMessage = createAssistantMessage("");
		toolCallMessage.content = [{ type: "toolCall", id: "call_make_video", name: tool.name, arguments: {} }];
		toolCallMessage.stopReason = "toolUse";
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			tools: [tool],
			responses: [toolCallMessage],
		});

		try {
			lineHandler(JSON.stringify({ id: "mid-run-portability", type: "prompt", message: "make a video" }));

			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "mid-run-portability")).toMatchObject([{ success: true }]);
				const portabilityErrors = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.type === "portability_error",
				);
				expect(portabilityErrors).toHaveLength(1);
				expect(portabilityErrors[0]).toMatchObject({
					type: "portability_error",
					kind: "portability_projection_unavailable",
					message: expect.stringContaining("generated.mp4"),
					report: expect.objectContaining({
						items: [expect.objectContaining({ attachmentId: generatedVideo.id })],
					}),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("carries JSONL prompt attachments through RPC mode into the provider context", async () => {
		const attachment: AttachmentRecord = {
			id: "att_rpc",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			source: { type: "base64", data: "JVBERi0xLjQ=" },
		};
		let providerContext: Context | undefined;
		testContextCapture.current = (context) => {
			providerContext = context;
		};
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "att-1", type: "prompt", message: "Analyze", attachments: [attachment] }));

			await vi.waitFor(() => {
				expect(providerContext?.attachmentRegistry?.resolve(attachment.id)).toEqual(attachment);
				expect(providerContext?.messages.find((message) => message.role === "user")).toMatchObject({
					attachments: [{ type: "attachment", attachmentId: attachment.id }],
				});
				expect(getPromptResponses(rpcIo.outputLines, "att-1")).toMatchObject([{ success: true }]);
			});
		} finally {
			await cleanup();
		}
	});

	it("uses the same provider option definitions and effective values over RPC", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "options-get", type: "get_provider_options" }));
			await vi.waitFor(() => {
				const response = parseOutputLines(rpcIo.outputLines).find((record) => record.id === "options-get");
				expect(response).toMatchObject({
					success: true,
					data: {
						definitions: expect.arrayContaining([
							expect.objectContaining({ key: "anthropic.document.citations", type: "boolean" }),
						]),
						effective: { "anthropic.document.citations": false },
					},
				});
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "options-set",
					type: "set_provider_option",
					key: "anthropic.document.citations",
					value: true,
				}),
			);
			await vi.waitFor(() => {
				const response = parseOutputLines(rpcIo.outputLines).find((record) => record.id === "options-set");
				expect(response).toMatchObject({
					success: true,
					data: {
						selected: { "anthropic.document.citations": true },
						effective: { "anthropic.document.citations": true },
					},
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("rejects malformed JSONL RPC attachments before provider execution", async () => {
		let providerCallCount = 0;
		testContextCapture.current = () => {
			providerCallCount += 1;
		};
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(
				JSON.stringify({
					id: "att-invalid",
					type: "prompt",
					message: "Analyze",
					attachments: [
						{ id: "att_bad", filename: "paper.pdf", mediaType: "application/pdf", source: { type: "path" } },
					],
				}),
			);

			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "att-invalid")).toMatchObject([
					{ success: false, error: expect.stringContaining("unsupported or malformed source") },
				]);
			});
			expect(providerCallCount).toBe(0);
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});
});
