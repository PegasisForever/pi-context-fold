import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { messageText } from "./dump.ts";
import { projectSlots, shortTokens } from "./project.ts";
import type { FoldBlock, Msg, Slot, ViewItem } from "./types.ts";

const MENU_MAX = 200;
const LABEL_MAX = 40;
/** PROMPTS.md §3b: the tool's own primary argument, and nothing else. "First non-empty string"
 * labels a `write` row with the file body it is writing, 82 times in the recorded corpus; a tool
 * with neither key is named alone, because a truncated argument blob recognises a span worse. */
const PRIMARY = ["path", "command"];

export interface MenuEntry {
	id: string;
	rounds: number;
	tokens: number;
	entryIds: string[];
	blockIds: string[];
	first: string;
	last: string;
}

export interface Menu {
	entries: MenuEntry[];
	tokens: number;
	text: string;
}

/**
 * A partition of the foldable view into at most `MENU_MAX` contiguous entries, divided evenly by
 * round count (§5). Nothing is hidden: every foldable round sits in exactly one entry, and
 * coarseness only costs precision at the two edges of a fold.
 */
export function buildMenu(view: ViewItem[], blocks: FoldBlock[]): Menu {
	// H1 drops the in-flight round and the one before it. A compaction entry is not offered because
	// it is the pointer to the overflow file, and folding it would lose the pointer (§5).
	const offered = rounds(projectSlots(view, blocks))
		.slice(0, -2)
		.filter((round) => !round.some((slot) => slot.message.role === "compactionSummary"));

	const entries: MenuEntry[] = [];
	const chunk = Math.ceil(offered.length / MENU_MAX);
	for (let at = 0; at < offered.length; at += chunk) {
		entries.push(entryOf(`e${entries.length + 1}`, offered.slice(at, at + chunk)));
	}
	return { entries, tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0), text: render(entries) };
}

/**
 * One round is one assistant message and the results answering its calls — the boundary unit, because
 * splitting one orphans a tool call (H2). Anything before the assistant message opens the round, so
 * every item is in exactly one round and the count equals the number of assistant messages.
 */
export function rounds<T extends { message: Msg }>(items: T[]): T[][] {
	const out: T[][] = [];
	let current: T[] = [];
	let pending: Set<string> | undefined;
	for (const item of items) {
		const message = item.message;
		const answers =
			pending !== undefined && message.role === "toolResult" && pending.has(message.toolCallId);
		if (pending !== undefined && !answers) {
			out.push(current);
			current = [];
			pending = undefined;
		}
		current.push(item);
		if (message.role === "assistant") pending = new Set(toolCallIds(message));
		else if (answers && pending && message.role === "toolResult") pending.delete(message.toolCallId);
	}
	if (current.length > 0) out.push(current);
	return out;
}

/** Two labels per entry, not one per round: a full menu holds ~6,400 rounds and keeps 400 labels. */
function entryOf(id: string, group: Slot[][]): MenuEntry {
	const slots = group.flat();
	// `chunk ≥ 1`, so a group always holds a first round, and past one it holds a different last.
	const first = roundLabel(group[0]!);
	return {
		id,
		rounds: group.length,
		tokens: slots.reduce((sum, slot) => sum + estimateTokens(slot.message), 0),
		entryIds: slots.flatMap((slot) => (slot.entryId === undefined ? [] : [slot.entryId])),
		blockIds: slots.flatMap((slot) => (slot.block === undefined ? [] : [slot.block.id])),
		first,
		last: group.length > 1 ? roundLabel(group.at(-1)!) : first,
	};
}

function roundLabel(round: Slot[]): string {
	const block = round.find((slot) => slot.block !== undefined)?.block;
	if (block !== undefined) {
		const head = `summary ${block.id} `;
		return `${head}"${clip(firstLine([block.summary]), LABEL_MAX - head.length - 2)}"`;
	}
	const call = round
		.flatMap((slot) => (slot.message.role === "assistant" ? slot.message.content : []))
		.find((part) => part.type === "toolCall");
	if (call === undefined) return clip(firstLine(round.map((slot) => messageText(slot.message))));
	const argument = primaryArgument(call.arguments);
	return clip(argument === "" ? call.name : `${call.name}: ${argument}`);
}

function firstLine(texts: string[]): string {
	for (const text of texts) {
		const [line] = text.trim().split("\n");
		if (line) return line;
	}
	return "";
}

function primaryArgument(args: Record<string, unknown>): string {
	for (const key of PRIMARY) {
		const value = args[key];
		if (typeof value === "string" && value !== "") return value.replace(/\s+/g, " ");
	}
	return "";
}

function clip(text: string, max: number = LABEL_MAX): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** PROMPTS.md §3a and §3b, in that order: the folding guidance, then the entries it applies to. What
 * qualifies for a fold at all is in the nudge instead, because that decision is made before this
 * call is paid for; what is here is what picking a span and writing a summary need. An
 * empty table takes §3b-empty alone — the guidance is for choosing a span, and there is none. */
function render(entries: MenuEntry[]): string {
	const first = entries[0];
	if (first === undefined) return EMPTY;
	const rows = entries.map(
		(entry) =>
			`  ${entry.id.padEnd(7)}${String(entry.rounds).padStart(6)}${shortTokens(entry.tokens).padStart(8)}  ` +
			`${entry.first === entry.last ? entry.first : `${entry.first} … ${entry.last}`}`,
	);
	const example = `Example: compress({from: "${first.id}", to: "${entries[1]?.id ?? first.id}", summary: "…"})`;
	return [INSTRUCTION, "", HEADING, "", COLUMNS, ...rows, "", example].join("\n");
}

const HEADING = "Foldable now — pick a span with from/to, or one entry with from == to.";
const COLUMNS = "  id     rounds  tokens  first … last";

export const EMPTY = `Nothing is foldable yet — every round so far is still in flight or immediately behind the
one in flight. Ask again when the conversation is longer.`;

export const INSTRUCTION = `Choosing the span. Keep out what the current step is still reading, and any instructions
you are still working under. A fold reissues the entry ids, so call compress() again for a
fresh list before folding again.

User messages may be folded like anything else. But a requirement, constraint or
acceptance criterion the user gave you must be quoted verbatim in the summary: it still
binds afterwards, and the summary becomes the only place it stays in view.

Writing the summary. You are its reader, later in this session, and the original stays on
disk. So write an index into recoverable text rather than a replacement for it: carry the
conclusions you would otherwise have to derive again, and say enough about the rest to know
when the file is worth opening.

Keep verbatim, because these are the search keys into that file and a paraphrase cannot be
grepped: full paths with line numbers, identifiers and signatures, error strings, versions,
numbers, thresholds. Keep what each piece of work was trying to settle, each decision with
the reason for it, each dead end with what killed it, and every question left open.

Drop the bulk you will not read again: logs, file contents, repeated status checks, the
discussion that reached a conclusion — keep the conclusion. For anything large you drop,
leave one line saying what was in it.

Record what happened, not what to do next; the work still to do is in the live
conversation. No fixed sections — thematic headers if the span covers several concerns,
dense bullets, whatever length the span needs.`;

function toolCallIds(message: Extract<Msg, { role: "assistant" }>): string[] {
	return message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []));
}
