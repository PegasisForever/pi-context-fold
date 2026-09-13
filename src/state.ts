import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FoldBlock } from "./types";

// `getBranch()`, never `buildContextEntries()`: the latter drops everything before a compaction cut,
// which would silently unfold every block older than it (§17.2). The cast is decision 29. Live means
// no later block absorbed it (§4c), derived not stored; absorbing takes the older block's entries
// over, because a record names what was in the view at fold time — its summary, not what it hid.
export function liveBlocks(sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">): FoldBlock[] {
	const live = new Map<string, FoldBlock>();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== "fold-block") continue;
		const block = entry.data as FoldBlock;
		const absorbed = new Set(block.blockIds);
		const entryIds = new Set(block.entryIds);
		for (const [id, older] of live) {
			if (!absorbed.has(id)) continue;
			for (const entryId of older.entryIds) entryIds.add(entryId);
			live.delete(id);
		}
		live.set(block.id, { ...block, entryIds: [...entryIds] });
	}
	return [...live.values()];
}
