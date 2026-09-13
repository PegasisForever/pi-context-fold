import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { FoldBlock } from "./types";

// DESIGN §6. For the human, never for the model. One context number and it is Pi's: ours equalled it
// on 23 of 23 recorded sessions, and where it differed ours was the wrong one (§7).
export function setFoldStatus(
	ctx: { ui: Pick<ExtensionUIContext, "setStatus">; getContextUsage: ExtensionContext["getContextUsage"] },
	blocks: FoldBlock[],
): void {
	const folded = blocks.reduce((sum, block) => sum + block.tokensBefore - block.tokensAfter, 0);
	const usage = ctx.getContextUsage();
	// `?` rather than a substituted number: null right after a compaction, undefined with no model.
	const context = usage && usage.tokens !== null ? `${short(usage.tokens)} / ${short(usage.contextWindow)}` : "?";
	ctx.ui.setStatus("fold", `fold  ${blocks.length} blocks · ${short(folded)} folded · ${context}`);
}

function short(tokens: number): string {
	return tokens < 1_000_000 ? `${Math.round(tokens / 1000)}K` : `${(tokens / 1_000_000).toFixed(1)}M`;
}
