import type { SessionContext } from "@earendil-works/pi-coding-agent";

// Pi augments `CustomAgentMessages` in `core/messages.ts`, so this is the full seven-role union and
// a `switch` on `role` is exhaustive. `test/replay.test.ts` proves both, in types and on the corpus.
export type Msg = SessionContext["messages"][number];

export interface ViewItem {
	entryId: string;
	message: Msg;
}

/** One message of the projected view, naming what a fold of it records: an entry, or an earlier block. */
export interface Slot {
	message: Msg;
	entryId?: string;
	block?: FoldBlock;
}

/** A folded span, persisted as a `fold-block` custom session entry. */
export interface FoldBlock {
	id: string;
	summary: string;
	entryIds: string[];
	/** Earlier blocks this one absorbed, which stop being live (design §4c). */
	blockIds: string[];
	dropToolCallIds: string[];
	msgs: number;
	tokensBefore: number;
	tokensAfter: number;
	originalPath: string;
	timestamp: number;
}
