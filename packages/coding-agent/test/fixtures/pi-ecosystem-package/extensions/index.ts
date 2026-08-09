import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function compatibilityFixture(pi: ExtensionAPI) {
	pi.registerTool({
		name: "compat_echo",
		label: "Compatibility echo",
		description: "Echo text from an upstream-format Pi extension",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: params.text }],
			details: {},
		}),
	});

	pi.registerCommand("compat-ping", {
		description: "Compatibility command",
		handler: async (_args, ctx) => {
			ctx.ui.notify("compat-pong");
		},
	});

	pi.on("input", async (event) => {
		if (event.text !== "compat-ping") return { action: "continue" };
		return {
			action: "transform",
			text: "compat-pong",
			...(event.images ? { images: event.images } : {}),
		};
	});
}
