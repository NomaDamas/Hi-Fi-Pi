import { getModel } from "@earendil-works/pi-ai/compat";
import { createHeadlessAgentHost } from "../../src/headless.ts";

const host = await createHeadlessAgentHost({
	cwd: process.cwd(),
	model: getModel("anthropic", "claude-sonnet-4-6"),
	noTools: "all",
	resourceLoaderOptions: {
		systemPrompt: "You are a concise research assistant. Cite uncertainty explicitly.",
		noThemes: true,
	},
});

const unsubscribe = host.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

try {
	await host.prompt("Explain one practical use of spectral graph theory.");
} finally {
	unsubscribe();
	await host.dispose();
}
