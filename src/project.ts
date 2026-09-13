import type { FoldBlock, Msg, ViewItem } from "./types";

// Drop covered entries, emit each block's summary at its first covered entry, and remove the
// compress pairs a fold retired (§6). Pure: no I/O, no decisions (D2).
export function project(view: ViewItem[], blocks: FoldBlock[]): Msg[] {
	const covering = new Map<string, FoldBlock>();
	const goneCalls = new Set<string>();
	for (const block of blocks) {
		for (const entryId of block.entryIds) covering.set(entryId, block);
		for (const callId of block.dropToolCallIds) goneCalls.add(callId);
	}
	closeOverPairs(view, covering);

	const out: Msg[] = [];
	const summarised = new Set<string>();
	for (const item of view) {
		const block = covering.get(item.entryId);
		if (block && !summarised.has(block.id)) {
			summarised.add(block.id);
			out.push(summaryMessage(block));
		}
		const kept = keep(item.message, block !== undefined, goneCalls);
		if (kept) out.push(kept);
	}
	return out;
}

/**
 * Coverage is closed under the call↔result pairing, transitively: a covered result takes its call,
 * that call's assistant message, and that message's other results. Messages that name the same call
 * id always fold together, so coverage is round-aligned and a summary at the block's first covered
 * entry cannot land between a surviving call and its result — unrepresentable, not handled (§6).
 */
function closeOverPairs(view: ViewItem[], covering: Map<string, FoldBlock>): void {
	const naming = new Map<string, ViewItem[]>();
	let wave: [ViewItem, FoldBlock][] = [];
	for (const item of view) {
		for (const callId of callIds(item.message)) naming.set(callId, [...(naming.get(callId) ?? []), item]);
		const block = covering.get(item.entryId);
		if (block) wave.push([item, block]);
	}
	while (wave.length > 0) {
		const next: [ViewItem, FoldBlock][] = [];
		for (const [item, block] of wave) {
			for (const callId of callIds(item.message)) {
				for (const partner of naming.get(callId) ?? []) {
					if (covering.has(partner.entryId)) continue;
					covering.set(partner.entryId, block);
					next.push([partner, block]);
				}
			}
		}
		wave = next;
	}
}

/** The call ids a message names: every call an assistant makes, or the one call a result answers. */
function callIds(message: Msg): string[] {
	if (message.role === "toolResult") return [message.toolCallId];
	if (message.role !== "assistant") return [];
	return message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []));
}

/**
 * Only a retired call reaches the edit below — a covered message goes whole, because the closure
 * covered its whole round. Retiring removes the call from its assistant message rather than removing
 * the message, because 8.6% of assistant messages carry two or more calls. Thinking goes with it: it
 * rides on every later request and says nothing the summary does not.
 */
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
function summaryMessage(block: FoldBlock): Msg {
	const tokens = `${thousands(block.tokensBefore)}→${thousands(block.tokensAfter)}`;
	const open = `<summary block="${block.id}" msgs="${block.msgs}" tokens="${tokens}" original="${block.originalPath}">`;
	return {
		role: "user",
		content: [{ type: "text", text: `${open}\n${block.summary}\n</summary>` }],
		timestamp: block.timestamp,
	};
}

function thousands(tokens: number): string {
	return `${(tokens / 1000).toFixed(1)}K`;
}
