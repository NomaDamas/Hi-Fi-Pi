import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FilesystemProductStorage,
	InMemoryProductCredentialBackend,
	type ProductIdentity,
	ProductStorageBoundaryError,
	ScopedProductCredentialStore,
} from "../src/product/storage.ts";

describe("product storage boundaries", () => {
	let root: string;
	let storage: FilesystemProductStorage;
	const tenantA: ProductIdentity = { tenantId: "tenant-a", userId: "user", agentId: "research", threadId: "one" };
	const tenantB: ProductIdentity = { tenantId: "tenant-b", userId: "user", agentId: "research", threadId: "one" };

	beforeEach(() => {
		root = join(tmpdir(), `hifi-product-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		storage = new FilesystemProductStorage({ root });
	});

	afterEach(() => {
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	it("requires an explicit root and rejects traversal identities", () => {
		expect(() => new FilesystemProductStorage({ root: "" })).toThrow(ProductStorageBoundaryError);
		expect(() => storage.pathsFor({ ...tenantA, tenantId: "../tenant-b" })).toThrow("tenantId is invalid");
		expect(() => storage.pathsFor({ ...tenantA, threadId: ".." })).toThrow("threadId is invalid");
	});

	it("keeps attachment bytes, metadata and remote IDs tenant scoped", () => {
		const attachment = storage.storeAttachment(tenantA, {
			id: "att_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			bytes: new TextEncoder().encode("%PDF-1.4"),
		});
		attachment.remotes = {
			openai: {
				provider: "openai",
				api: "openai-responses",
				fileId: "file_tenant_a",
				endpoint: "https://api.openai.com/v1",
				uploadedAt: 1,
			},
		};
		storage.attachmentRegistry(tenantA).update?.(attachment);

		expect(storage.attachmentRegistry(tenantA).resolve("att_pdf")).toMatchObject({
			id: "att_pdf",
			remotes: { openai: { fileId: "file_tenant_a" } },
		});
		expect(new TextDecoder().decode(storage.attachmentRegistry(tenantA).read?.(attachment))).toBe("%PDF-1.4");
		expect(storage.attachmentRegistry(tenantB).resolve("att_pdf")).toBeUndefined();
	});

	it("resumes only sessions owned by the selected tenant and thread", () => {
		const attachment = storage.storeAttachment(tenantA, {
			id: "att_pdf",
			filename: "paper.pdf",
			mediaType: "application/pdf",
			bytes: new TextEncoder().encode("%PDF"),
		});
		const manager = storage.createSessionManager(tenantA, root);
		manager.appendAttachment(attachment);
		manager.appendCustomEntry("test", { ready: true });
		manager.appendMessage(fauxAssistantMessage("done"));
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();

		const resumed = storage.openSessionManager(tenantA, basename(sessionFile!));
		expect(resumed.getAttachments()).toEqual([attachment]);
		expect(() => storage.openSessionManager(tenantB, basename(sessionFile!))).toThrow("session does not exist");
		expect(() => storage.openSessionManager(tenantA, sessionFile!)).toThrow("scoped basename");
	});

	it("selects credentials from the exact product identity", async () => {
		const backend = new InMemoryProductCredentialBackend();
		const credentialsA = new ScopedProductCredentialStore(backend, tenantA);
		const credentialsB = new ScopedProductCredentialStore(backend, tenantB);
		await credentialsA.modify("openai", async () => ({ type: "api_key", key: "tenant-a-key" }));
		await credentialsB.modify("openai", async () => ({ type: "api_key", key: "tenant-b-key" }));

		expect(await credentialsA.read("openai")).toEqual({ type: "api_key", key: "tenant-a-key" });
		expect(await credentialsB.read("openai")).toEqual({ type: "api_key", key: "tenant-b-key" });
		expect(await credentialsA.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
	});

	it("keeps concurrent thread state in distinct directories and cleans up explicitly", () => {
		const secondThread = { ...tenantA, threadId: "two" };
		const first = storage.createSessionManager(tenantA, root);
		const second = storage.createSessionManager(secondThread, root);
		first.appendCustomEntry("thread", "one");
		second.appendCustomEntry("thread", "two");

		expect(first.getSessionFile()).not.toBe(second.getSessionFile());
		expect(storage.pathsFor(tenantA).thread).not.toBe(storage.pathsFor(secondThread).thread);
		storage.cleanupThread(tenantA);
		expect(existsSync(storage.pathsFor(tenantA).thread)).toBe(false);
		expect(existsSync(storage.pathsFor(secondThread).thread)).toBe(true);
	});
});
