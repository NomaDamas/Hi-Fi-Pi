import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(3000));
		// First 2000 chars should be present
		expect(result).toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
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
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});

	it("preserves readable provider-native state markers without serializing opaque payloads", () => {
		const secret = "opaque-provider-secret";
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-test",
				nativeParts: [
					{
						type: "provider-native",
						provider: "anthropic",
						kind: "server-tool-state",
						payload: { token: secret },
					},
				],
				citations: [{ type: "citation", title: "Paper", raw: { token: secret } }],
				reasoningState: [{ provider: "anthropic", encrypted: secret }],
				providerState: { provider: "anthropic", responseId: secret },
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Assistant citations]: Paper");
		expect(result).toContain("anthropic/server-tool-state");
		expect(result).toContain("anthropic/reasoning");
		expect(result).toContain("anthropic/conversation-state");
		expect(result).not.toContain(secret);
	});
});
