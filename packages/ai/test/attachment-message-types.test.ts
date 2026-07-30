import { describe, expect, expectTypeOf, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type {
	AttachmentRecord,
	AttachmentReference,
	AttachmentRegistry,
	Context,
	Message,
	Model,
	ProviderFileReference,
	ToolResultMessage,
	UserMessage,
} from "../src/types.ts";

const TIMESTAMP = 1_700_000_000_000;

function makeTextOnlyModel(): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

function makeAttachmentRecord(source: AttachmentRecord["source"]): AttachmentRecord {
	return {
		id: "att_1",
		filename: "paper.pdf",
		mediaType: "application/pdf",
		sizeBytes: 1_024,
		sha256: "abc123",
		source,
	};
}

describe("attachment-aware message types", () => {
	it("keeps the serialized shape of legacy user and tool-result messages unchanged", () => {
		const userMessage: UserMessage = {
			role: "user",
			content: "hello",
			timestamp: TIMESTAMP,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: TIMESTAMP,
		};

		expect(JSON.stringify(userMessage)).toBe('{"role":"user","content":"hello","timestamp":1700000000000}');
		expect(JSON.stringify(toolResult)).toBe(
			'{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"done"}],"isError":false,"timestamp":1700000000000}',
		);
		expect(userMessage).not.toHaveProperty("attachments");
		expect(toolResult).not.toHaveProperty("attachments");
	});

	it("represents path, base64, and URL sources without changing legacy content", () => {
		const records: AttachmentRecord[] = [
			makeAttachmentRecord({ type: "path", path: "/tmp/paper.pdf" }),
			makeAttachmentRecord({ type: "base64", data: "JVBERi0xLjQ=" }),
			makeAttachmentRecord({ type: "url", url: "https://example.com/paper.pdf" }),
		];
		const reference: AttachmentReference = { type: "attachment", attachmentId: "att_1" };
		const message: UserMessage = {
			role: "user",
			content: "Analyze paper.pdf",
			attachments: [reference],
			timestamp: TIMESTAMP,
		};

		expect(records.map((record) => record.source.type)).toEqual(["path", "base64", "url"]);
		expect(message.content).toBe("Analyze paper.pdf");
		expect(message.attachments).toEqual([reference]);
	});

	it("keeps provider file references separate from the provider-neutral source", () => {
		const remote: ProviderFileReference = {
			provider: "openai",
			api: "openai-responses",
			fileId: "file_123",
			uploadedAt: TIMESTAMP,
			expiresAt: TIMESTAMP + 60_000,
		};
		const record: AttachmentRecord = {
			...makeAttachmentRecord({ type: "path", path: "/tmp/paper.pdf" }),
			remotes: { "openai:openai-responses": remote },
		};

		expect(record.source).toEqual({ type: "path", path: "/tmp/paper.pdf" });
		expect(record.remotes?.["openai:openai-responses"]).toEqual(remote);
	});

	it("allows tool results to reference attachments alongside legacy image content", () => {
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "create_report",
			content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			attachments: [{ type: "attachment", attachmentId: "att_1" }],
			isError: false,
			timestamp: TIMESTAMP,
		};

		expect(message.content[0]?.type).toBe("image");
		expect(message.attachments).toEqual([{ type: "attachment", attachmentId: "att_1" }]);
	});

	it("round-trips attachment records and references through JSON", () => {
		const record = makeAttachmentRecord({ type: "path", path: "/tmp/paper.pdf" });
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "Analyze this" }],
			attachments: [{ type: "attachment", attachmentId: record.id }],
			timestamp: TIMESTAMP,
		};

		expect(JSON.parse(JSON.stringify({ record, message }))).toEqual({ record, message });
	});

	it("preserves attachment sidecars through legacy message transformation", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Analyze this" },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				attachments: [{ type: "attachment", attachmentId: "att_1" }],
				timestamp: TIMESTAMP,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "create_report",
				content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
				attachments: [{ type: "attachment", attachmentId: "att_2" }],
				isError: false,
				timestamp: TIMESTAMP,
			},
		];

		const transformed = transformMessages(messages, makeTextOnlyModel());
		const userMessage = transformed.find((message) => message.role === "user");
		const toolResult = transformed.find((message) => message.role === "toolResult");

		expect(userMessage?.attachments).toEqual([{ type: "attachment", attachmentId: "att_1" }]);
		expect(toolResult?.attachments).toEqual([{ type: "attachment", attachmentId: "att_2" }]);
	});

	it("exposes a request-scoped attachment registry on Context", () => {
		const record = makeAttachmentRecord({ type: "path", path: "/tmp/paper.pdf" });
		const registry: AttachmentRegistry = {
			resolve: (id) => (id === record.id ? record : undefined),
			list: () => [record],
		};
		const context: Context = {
			messages: [],
			attachmentRegistry: registry,
		};

		expect(context.attachmentRegistry?.resolve("att_1")).toBe(record);
		expect(context.attachmentRegistry?.resolve("missing")).toBeUndefined();
		expectTypeOf(context.attachmentRegistry).toEqualTypeOf<AttachmentRegistry | undefined>();
	});
});
