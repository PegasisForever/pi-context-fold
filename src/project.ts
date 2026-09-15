import type { FoldBlock, Msg, Slot, ViewItem } from "./types.ts";

export const TOOL_NAME = "compact";

/** The `customType` on every nudge this extension sends (see `nudge.ts`). Defined here so the
 * projection can recognise nudges without importing the sender (which imports from here). */
export const NUDGE_CUSTOM_TYPE = "pi-context-fold";

/** Covered entries out, each block's summary at its first covered entry, retired compact pairs out,
 * pre-fold nudges out (§6, §8). Pure: no I/O, no decisions (D2). The retired calls are derived here,
 * not passed in: every caller wants the same ones and a caller that forgot would put a dead 5K menu
 * back in the view. A nudge older than the newest fold existed when that fold landed, so the model
 * has acted on it and its numbers are stale; the next reminder arrives on growth anyway. */
export function projectSlots(view: ViewItem[], blocks: FoldBlock[]): Slot[] {
	const covering = new Map<string, FoldBlock>();
	for (const block of blocks) {
		for (const entryId of block.entryIds) covering.set(entryId, block);
	}
	const goneCalls = new Set(staleMenuCalls(view));
	const goneNudges = staleNudgeEntries(view, blocks);
	for (const block of blocks) {
		for (const callId of block.dropToolCallIds) goneCalls.add(callId);
	}

	const out: Slot[] = [];
	const summarised = new Set<string>();
	for (const item of view) {
		const block = covering.get(item.entryId);
		if (block && !summarised.has(block.id)) {
			summarised.add(block.id);
			out.push({ message: summaryMessage(block), block });
			// The fold's own result is seen once mid-turn and leaves with its call, so without
			// this the next choice happens with no record of what just landed (§4b). Two
			// newer assistants means the model has answered past a menu round-trip, so the
			// note is gone by the second fold decision at the latest.
			if (assistantsNewerThan(view, block.timestamp) < 2) out.push({ message: foldReceipt(block) });
		}
		// An answered nudge leaves no slot, but a folded nudge still anchors its summary above.
		if (goneNudges.has(item.entryId)) continue;
		const kept = keep(item.message, block !== undefined, goneCalls);
		if (kept) out.push({ message: kept, entryId: item.entryId });
	}
	return out;
}

/** The compact calls whose menu result has been in the view for a round. The menu costs ~5K and is
 * dead once the model has answered it, whether or not it folded (§8); a failed fold is not a menu
 * call, so failures stay visible untouched (§6). */
export function staleMenuCalls(view: ViewItem[]): string[] {
	const stale: string[] = [];
	let served: string[] = [];
	for (const item of view) {
		const message = item.message;
		if (message.role !== "assistant") continue;
		stale.push(...served);
		served = [];
		for (const part of message.content) {
			if (part.type === "toolCall" && part.name === TOOL_NAME && noArguments(part.arguments))
				served.push(part.id);
		}
	}
	return stale;
}

/** A1: every nudge older than the newest fold. It existed when that fold landed, so the model has
 * acted on it. No span mapping and no new record: creation order is enough, and a spontaneous fold
 * retires the same way. A folded nudge still anchors its summary at its loop above. */
export function staleNudgeEntries(view: ViewItem[], blocks: FoldBlock[]): Set<string> {
	let newest = 0;
	for (const block of blocks) {
		if (block.timestamp > newest) newest = block.timestamp;
	}
	const stale = new Set<string>();
	if (newest === 0) return stale;
	for (const item of view) {
		const message = item.message;
		if (
			message.role === "custom" &&
			message.customType === NUDGE_CUSTOM_TYPE &&
			message.timestamp < newest
		)
			stale.add(item.entryId);
	}
	return stale;
}

/** Assistants in the view newer than a timestamp. The clock every ephemeral note ages by: the menu
 * is fresh for the current assistant message or the one before it, and the fold receipt below
 * survives one menu round-trip the same way. Counts view assistants, never projected ones. */
export function assistantsNewerThan(view: ViewItem[], timestamp: number): number {
	let n = 0;
	for (const item of view) {
		const message = item.message;
		if (message.role === "assistant" && message.timestamp > timestamp) n++;
	}
	return n;
}

/** MODEL-FACING-TEXT.md §4b. Derived from the record at send time — never stored, never paired, so
 * no orphan risk and nothing to absorb. No span ids: the menu that issued them is already stale or
 * going, and reissued ids would point at new text. The id names the block whose summary stands
 * directly above the note (its transcript path carries the same id). */
export function foldReceipt(block: FoldBlock): Msg {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `<${NUDGE_CUSTOM_TYPE}>\n${receiptText(block)}\n</${NUDGE_CUSTOM_TYPE}>`,
			},
		],
		timestamp: block.timestamp,
	};
}

/** The numbers are the receipt; the last sentence is the stop rule. It lives here and not in the
 * menu because the choice it serves exists only on post-fold turns: first folds answer the nudge
 * or the user's order, which already cover whether. */
export function receiptText(block: FoldBlock): string {
	return (
		`Compacted ${block.msgs} messages into ${block.id}. ` +
		`${shortTokens(block.tokensBefore)} → ${shortTokens(block.tokensAfter)}. ` +
		`Only compact again if large finished work is left; otherwise carry on with the user's work.`
	);
}

/** Empty, not "names no span": the extension this replaces also called its tool `compress` and carried
 * the span in `content`, so 27 such calls across 9 of the 25 recorded sessions read as menu calls and
 * retired 54 real messages. Our own menu call arrives as `{}`. */
export function noArguments(args: Record<string, unknown>): boolean {
	return Object.keys(args).length === 0;
}

/** A covered message goes whole; only a retired call reaches the edit. Retiring takes the call out of
 * its assistant message rather than the message (8.6% carry two or more), and thinking goes with it.
 * 6,654 of 7,443 recorded assistant messages carry no text, so retiring the one call of a bare
 * call-only message empties it, and an empty message is not a message. */
function keep(message: Msg, covered: boolean, goneCalls: Set<string>): Msg | undefined {
	if (covered) return undefined;
	if (message.role === "toolResult") return goneCalls.has(message.toolCallId) ? undefined : message;
	if (message.role !== "assistant") return message;
	if (!message.content.some((part) => part.type === "toolCall" && goneCalls.has(part.id))) return message;
	const content = message.content.filter(
		(part) => part.type !== "thinking" && !(part.type === "toolCall" && goneCalls.has(part.id)),
	);
	return content.length === 0 ? undefined : { ...message, content };
}

/** MODEL-FACING-TEXT.md §6. Pi wraps its own compaction summaries this way, so the tag needs no explaining.
 * One attribute: the path is the only one the model can act on. The block id, the message count and
 * the two token numbers were ours to read, and the TUI reads them from the record instead. */
export function summaryMessage(block: FoldBlock): Msg {
	const open = `<summary full-transcript="${block.originalPath}">`;
	return {
		role: "user",
		content: [{ type: "text", text: `${open}\n${block.summary}\n</summary>` }],
		timestamp: block.timestamp,
	};
}

/**
 * One number format for the whole project. It is close to Pi's footer rule but not the same one:
 * Pi prints `712` and `3.1k`, this prints `0.7K` and `3.1K`. Pi does not export its formatter, so
 * there is nothing to reuse and the difference is ours to own.
 */
export function shortTokens(tokens: number): string {
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}K`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}K`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}
