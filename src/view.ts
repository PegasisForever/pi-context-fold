import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import type { ViewItem } from "./types.ts";

// From Pi's session projection, not `event.messages`: handlers chain and pi-goal-x deletes messages
// before we run, so a position there addresses nothing. The projection, not `buildContextEntries()`:
// it applies Pi's `context_edit` entries, and the overflow retry drops the truncated answer with one,
// so raw entries put it back last and the request ends on the model's turn (§3). Items are Pi's own
// objects, never mutated (C6).
export function buildView(entries: ProjectedSessionEntry[]): ViewItem[] {
	const items: ViewItem[] = [];
	for (const entry of entries) {
		for (const message of entry.messages) {
			// Pi 0.86+ stores the prompt and tool set as `system` messages in the transcript. The
			// `context` handler must not return them (Pi puts the current one back in front), and a
			// fold must never take one away, so they stay out of the view.
			if (message.role === "system") continue;
			items.push({ entryId: entry.sourceEntry.id, message });
		}
	}
	return items;
}
