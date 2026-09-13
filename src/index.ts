import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { project } from "./project";
import { liveBlocks } from "./state";
import { setFoldStatus } from "./status";
import { buildView } from "./view";

export default function contextFold(pi: ExtensionAPI): void {
	pi.on("context", (_event, ctx) => {
		const view = buildView(ctx.sessionManager.buildContextEntries());
		return { messages: project(view, liveBlocks(ctx.sessionManager)) };
	});

	// Reporting happens here, never in the `context` handler, which stays a pure projection with no
	// I/O and no decisions (D2, D3).
	pi.on("turn_end", (_event, ctx) => {
		setFoldStatus(ctx, liveBlocks(ctx.sessionManager));
	});
}
