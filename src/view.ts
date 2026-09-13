import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { ViewItem } from "./types.ts";

// From entries, not `event.messages`: handlers chain and pi-goal-x deletes messages before we run,
// so a position there addresses nothing. Items are Pi's own objects, never mutated (§3, C6).
export function buildView(entries: SessionEntry[]): ViewItem[] {
	const items: ViewItem[] = [];
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) {
			items.push({ entryId: entry.id, message });
		}
	}
	return items;
}
