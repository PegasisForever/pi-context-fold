import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { shortTokens } from "./project";
import type { FoldBlock } from "./types";

// No context number: at 80 columns pi-powerline-footer's overflow row dropped the whole line (§6).
export function setFoldStatus(ctx: { ui: Pick<ExtensionUIContext, "setStatus"> }, blocks: FoldBlock[]): void {
	const folded = blocks.reduce((sum, block) => sum + block.tokensBefore - block.tokensAfter, 0);
	ctx.ui.setStatus("fold", `folded ${shortTokens(folded)}, ${blocks.length} block${blocks.length === 1 ? "" : "s"}`);
}
