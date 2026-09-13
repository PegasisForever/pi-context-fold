import type { FoldBlock, Msg, Slot, ViewItem } from "./types.ts";

export const TOOL_NAME = "compress";

/** Covered entries out, each block's summary at its first covered entry, retired compress pairs out
 * (§6). Pure: no I/O, no decisions (D2). The retired calls are derived here, not passed in: every
 * caller wants the same ones and a caller that forgot would put a dead 5K menu back in the view. */
export function projectSlots(view: ViewItem[], blocks: FoldBlock[]): Slot[] {
	const covering = new Map<string, FoldBlock>();
	for (const block of blocks) {
		for (const entryId of block.entryIds) covering.set(entryId, block);
	}
	const goneCalls = new Set(staleMenuCalls(view));
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
		const kept = keep(item.message, block !== undefined, goneCalls);
		if (kept) out.push({ message: kept, entryId: item.entryId });
	}
	return out;
}

/** The compress calls whose menu result has been in the view for a round. The menu costs ~5K and is
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

/** PROMPTS.md §6. Pi wraps its own compaction summaries this way, so the tag needs no explaining. */
export function summaryMessage(block: FoldBlock): Msg {
	const tokens = `${shortTokens(block.tokensBefore)}→${shortTokens(block.tokensAfter)}`;
	const open = `<summary block="${block.id}" msgs="${block.msgs}" tokens="${tokens}" original="${block.originalPath}">`;
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
