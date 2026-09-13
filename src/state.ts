import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FoldBlock } from "./types";

// `getBranch()`, never `buildContextEntries()`: the latter drops everything before a compaction cut,
// which would silently unfold every block older than it (§17.2). The cast is decision 29.
export function liveBlocks(sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">): FoldBlock[] {
	const records: FoldBlock[] = [];
	for (const entry of sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "fold-block") records.push(entry.data as FoldBlock);
	}
	return absorb(records);
}

// Live means no later block absorbed it (§4c), derived not stored. Absorbing takes the older block's
// entries and its retired calls over: without the call ids, condensing summaries puts the older
// fold's compress call back in the view, and that call's arguments still carry the whole summary it
// replaced. Idempotent on an already-absorbed list, so a pending fold can be tested against it.
export function absorb(blocks: FoldBlock[]): FoldBlock[] {
	const live = new Map<string, FoldBlock>();
	for (const block of blocks) {
		const absorbed = new Set(block.blockIds);
		const entryIds = new Set(block.entryIds);
		const dropToolCallIds = new Set(block.dropToolCallIds);
		for (const [id, older] of live) {
			if (!absorbed.has(id)) continue;
			for (const entryId of older.entryIds) entryIds.add(entryId);
			for (const callId of older.dropToolCallIds) dropToolCallIds.add(callId);
			live.delete(id);
		}
		live.set(block.id, { ...block, entryIds: [...entryIds], dropToolCallIds: [...dropToolCallIds] });
	}
	return [...live.values()];
}
