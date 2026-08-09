/**
 * Minimal deep provider backend example.
 *
 * Pair this extension with a models.json provider named `acme-docs` whose API is
 * `acme-documents` and base URL is https://api.acme.example/v1.
 */
import { type AssistantMessage, type AttachmentRecord, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function inlineAttachment(record: AttachmentRecord): { filename: string; mediaType: string; data: string } {
	if (record.source.type !== "base64") {
		throw new Error(`The Acme example only accepts base64 attachments, received ${record.source.type}`);
	}
	return { filename: record.filename, mediaType: record.mediaType, data: record.source.data };
}

export default function providerBackendExample(pi: ExtensionAPI): void {
	pi.registerProviderBackend({
		apiVersion: 1,
		id: "acme-document-backend",
		match: {
			provider: "acme-docs",
			api: "acme-documents",
			baseUrl: "https://api.acme.example/v1",
		},
		resolveCapabilities: () => ({
			inputs: { document: { mediaTypes: ["application/pdf"], sources: ["base64"] } },
		}),
		prepareInput: ({ conversation }) => ({
			request: {
				messages: conversation.messages.map((message) => ({
					role: message.role,
					content: "content" in message ? message.content : undefined,
					attachments:
						"attachments" in message
							? message.attachments?.map((reference) => {
									const record = conversation.attachmentRegistry?.resolve(reference.attachmentId);
									if (!record) throw new Error(`Missing attachment ${reference.attachmentId}`);
									return inlineAttachment(record);
								})
							: undefined,
				})),
			},
		}),
		stream: async ({ api, baseUrl, modelId, options, request }) => {
			const response = await fetch(`${baseUrl}/generate`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(options?.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
				},
				body: JSON.stringify({ model: modelId, ...((request as object | undefined) ?? {}) }),
				signal: options?.signal,
			});
			if (!response.ok) throw new Error(`Acme request failed with HTTP ${response.status}`);
			const body = (await response.json()) as { text?: string };
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: body.text ?? "" }],
				api,
				provider: "acme-docs",
				model: modelId,
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
			const stream = createAssistantMessageEventStream();
			const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...partial } });
				partial.content = [{ type: "text", text: "" }];
				stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
				partial.content = [{ type: "text", text: body.text ?? "" }];
				stream.push({ type: "text_delta", contentIndex: 0, delta: body.text ?? "", partial: { ...partial } });
				stream.push({ type: "text_end", contentIndex: 0, content: body.text ?? "", partial: { ...partial } });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
	});
}
