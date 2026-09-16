import { basename, dirname } from "node:path";
import type { FoldBlock, Msg, Slot, ViewItem } from "./types.ts";

export const TOOL_NAME = "compact";

/** The `customType` on the receipt each landed fold sends (see `fold.ts`). Stored, like nudges
 * and menus — never derived: a note that exists only in the projection cannot be told apart from
 * a note that was never sent, and the log cannot confirm it. Separate from the nudge type because
 * a nudge is retired by the next fold and a receipt is retired by nothing: it is the only record
 * that the model compacted, and it stays in the view until a later fold covers it (§4b). */
export const RECEIPT_CUSTOM_TYPE = "pi-context-fold-receipt";

/** The `customType` on every nudge this extension sends (see `nudge.ts`). Defined here so the
 * projection can recognise nudges without importing the sender (which imports from here). */
export const NUDGE_CUSTOM_TYPE = "pi-context-fold";

/** Covered entries out, each block's summary at its first covered entry, retired compact pairs out,
 * pre-fold nudges out (§6, §8). Pure: no I/O, no decisions (D2). The retired calls are derived
 * here, not passed in: every caller wants the same ones and a caller that forgot would put a dead
 * 5K menu back in the view. A nudge older than the newest fold existed when that fold landed, so
 * the model has acted on it and its numbers are stale; the next reminder arrives on growth anyway.
 * Receipts are not in that list: they are the record of what the model did, and a record that
 * expires is a record the model can be asked to act without (§4b). */
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
		}
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

/** MODEL-FACING-TEXT.md §4 and §4b. The one text a `compact` call is reported with: its tool
 * result and its stored receipt both say exactly this, so the two can never disagree. One text per
 * call, however many blocks landed: the closing sentence is said once, and the folder once, where
 * one note per block repeated both on every later request. "Carry on" lives here and not in the
 * menu because the choice it serves exists only on post-fold turns. No span ids: the receipt stays
 * in the view for good, and the menu that issued them is already stale or going. Paths sit in
 * backticks, so no punctuation can be read as part of them, and they outlive the summaries: a later
 * fold that absorbs a block takes its summary away, never its file. Read in order, the receipts
 * are the ledger of what this session has compacted. */
export function receiptText(blocks: FoldBlock[]): string {
	const [only] = blocks;
	if (only !== undefined && blocks.length === 1) {
		return (
			`You just compacted ${count(only.msgs)} messages into ${only.id}. ` +
			`${shortTokens(only.tokensBefore)} → ${shortTokens(only.tokensAfter)}. ` +
			`Carry on with the user's work. ` +
			`Full transcript is saved at: \`${only.originalPath}\``
		);
	}
	// One call writes every block into the same session folder.
	const folder = dirname(blocks[0]!.originalPath);
	const msgs = blocks.reduce((sum, block) => sum + block.msgs, 0);
	return [
		`You just compacted ${count(msgs)} messages into ${blocks.length} blocks. Full transcripts are saved in \`${folder}/\`:`,
		...blocks.map(
			(block) =>
				`- ${block.id}: ${count(block.msgs)} messages, ` +
				`${shortTokens(block.tokensBefore)} → ${shortTokens(block.tokensAfter)}, \`${basename(block.originalPath)}\``,
		),
		"Carry on with the user's work.",
	].join("\n");
}

const count = (n: number): string => n.toLocaleString("en-US");

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
		content: [
			{ type: "text", text: `${open}\n${summaryBody(block.summary, block.quotes ?? [])}\n</summary>` },
		],
		timestamp: block.timestamp,
	};
}

/** The model's summary, then the user's own messages under it, each in a tag of its own. Asked to
 * keep them verbatim, one model kept 36 of 200 (§3a); code keeps all of them. */
export function summaryBody(summary: string, quotes: string[]): string {
	if (quotes.length === 0) return summary;
	return [summary, "", ...quotes.map((quote) => `<user-message>${quote}</user-message>`)].join("\n");
}

/** What the user sent in one message, word for word, for `quotes`: its text parts. A message with no
 * text gives nothing. */
export function typedText(message: Msg): string[] {
	if (message.role !== "user") return [];
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	return text === "" ? [] : [text];
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
