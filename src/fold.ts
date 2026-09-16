import { type ExtensionAPI, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { originalPath, writeOriginal } from "./dump.ts";
import { log } from "./log.ts";
import { buildMenu, type Menu, type MenuEntry } from "./menu.ts";
import {
	NUDGE_CUSTOM_TYPE,
	noArguments,
	projectSlots,
	RECEIPT_CUSTOM_TYPE,
	receiptText,
	shortTokens,
	TOOL_NAME,
} from "./project.ts";
import { header, type Shown, shown } from "./shown.ts";
import { liveBlocks } from "./state.ts";
import type { FoldBlock, Msg, Slot, ViewItem } from "./types.ts";
import { buildView } from "./view.ts";

const span = Type.Object({
	from: Type.String({
		description: 'first entry of the span, e.g. "e3". From the list compact() returns.',
	}),
	to: Type.String({ description: "last entry of the span, inclusive. At or after from." }),
	summary: Type.String({ description: "this text will replace the span in your context." }),
});

const parameters = Type.Object({
	spans: Type.Optional(
		Type.Array(span, {
			description: "the spans to compact. They must not overlap. Omit to get the list.",
		}),
	),
});

type Params = Static<typeof parameters>;
type Span = Static<typeof span>;

/** One span, resolved against the menu it names: where it sits in that menu, and its own fields. */
interface Fold {
	at: number;
	end: number;
	entries: MenuEntry[];
	from: string;
	to: string;
	summary: string;
}

/** What survives between calls: the menu the ids belong to, and whether this round folded. */
export interface FoldState {
	menu: Menu | undefined;
	/** Assistant messages in the view when that menu was served. See `fresh` (§5). */
	menuAt: number;
	folded: boolean;
	/** Where growth is counted from (§8). `undefined` means "the next measurement": set by a request
	 * to compact, whose own turn is the first chance to measure. */
	baseline: number | undefined;
	reported: Set<string>;
}

// The one tool (§6). No arguments returns the menu; arguments fold. Arguments are Pi's own parse and
// schema validation, with no `prepareArguments` shim: lenient parsing exists in the original for a
// Qwen in non-strict tool mode and a local quantised 27B, which C2 excludes.
export function registerFold(pi: ExtensionAPI, state: FoldState): void {
	pi.registerTool<typeof parameters, Shown>({
		name: TOOL_NAME,
		label: "Compact",
		description:
			"Compact spans of the conversation into summaries you write, saving the full transcription to a file, freeing context. Always call `compact()` with no arguments to list what can be compacted, before you compact a span.",
		parameters,
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const view = buildView(ctx.sessionManager.buildContextEntries());
			const blocks = liveBlocks(ctx.sessionManager);
			if (noArguments(params)) {
				state.menu = buildMenu(view, blocks);
				state.menuAt = assistants(view);
				return {
					content: [{ type: "text", text: state.menu.text }],
					// The menu costs ~5.4K tokens and reads as a wall of ids. You get the size of it.
					details: { lines: menuForYou(state.menu) },
				};
			}

			// Every span is resolved against one menu and planned against one projection, so no span's
			// result depends on another span, or on the order they arrived in.
			const folds = resolve(state, params, assistants(view));
			const sessionId = ctx.sessionManager.getSessionId();
			const slots = projectSlots(view, blocks);
			const base = nextBlockNumber(ctx.sessionManager.getBranch());
			const planned = folds.map((fold, i) => plan(slots, fold, `b${base + i}`, toolCallId, sessionId));
			// C7. A fold against a menu the view has moved past replaces nothing: it would report a
			// success, write a zero-byte original and drop the summary the model just wrote. Reversing
			// the span produces the same empty plan, so one condition answers both (§5).
			const empty = planned.find((one) => one.taken.length === 0);
			if (empty !== undefined) {
				throw new Error(
					`Compacting ${empty.fold.from}–${empty.fold.to} would replace nothing: the list is out of date. Call compact() for the current one.`,
				);
			}

			// The log goes first. `appendFileSync` can throw, and after the writes below that would
			// report a failure for a fold which had in fact been applied.
			for (const { record } of planned) {
				log("fold", {
					block: record.id,
					msgs: record.msgs,
					tokensBefore: record.tokensBefore,
					tokensAfter: record.tokensAfter,
				});
				// The one measurement with no decision attached: the fold still happens.
				if (record.tokensAfter >= record.tokensBefore) log("fold-grew", { block: record.id });
			}
			// Every transcript before any record. A file no record points at is inert; a record whose
			// file was never written is a summary pointing at nothing.
			for (const { record, taken } of planned) writeOriginal(sessionId, record.id, taken);
			applyAll(pi, planned);
			state.menu = undefined;
			state.folded = true;
			// One text per landed block (§4, §4b), said twice: in the result, which leaves the view
			// with its call on the very next request, and in a stored note, an entry in the log and
			// the TUI like every other extension message, which stays in the view. Only fully applied
			// folds get one — applyAll throws before this on a partial failure.
			const texts = planned.map(({ record }) => receiptText(record));
			for (const text of texts) {
				pi.sendMessage<Shown>(
					{
						customType: RECEIPT_CUSTOM_TYPE,
						content: `<${NUDGE_CUSTOM_TYPE}>\n${text}\n</${NUDGE_CUSTOM_TYPE}>`,
						details: { lines: [text] },
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
			}
			return {
				content: [{ type: "text", text: texts.join("\n") }],
				details: { lines: planned.map((one) => foldForYou(one.record, one.fold)) },
			};
		},
		renderCall: (params, theme) =>
			header(theme, TOOL_NAME, noArguments(params) ? undefined : named(params)),
		renderResult: (result, _options, theme) => shown(result, theme),
	});
}

/** Assistant messages in the view. The unit the menu ages in: `staleMenuCalls` retires a menu once a
 * later assistant message exists, so one more than the count at menu time is the last moment the
 * model can still see the list it is naming ids from. */
function assistants(view: ViewItem[]): number {
	return view.filter((item) => item.message.role === "assistant").length;
}

/** MODEL-FACING-TEXT.md §5. Each failure names the id and the next action; none of them returns the menu. */
function resolve(state: FoldState, params: Params, now: number): Fold[] {
	const spans = params.spans ?? [];
	if (spans.length === 0)
		throw new Error("spans is empty. Call compact() with no arguments for the list of spans.");
	// The ids are only meaningful against the menu that issued them, and that menu leaves the view one
	// assistant message later — so a span named after that is named from something no longer there.
	if (state.menu === undefined || now - state.menuAt > 1)
		throw new Error(
			"The list these ids came from is not the current one. Call compact() with no arguments, then compact in your next message.",
		);
	const folds = spans.map((one) => resolveSpan(state.menu as Menu, one)).sort((a, b) => a.at - b.at);
	for (let i = 1; i < folds.length; i++) {
		const before = folds[i - 1]!;
		const after = folds[i]!;
		if (after.at <= before.end)
			throw new Error(
				`Spans ${before.from}–${before.to} and ${after.from}–${after.to} overlap. Every entry can be in one span only.`,
			);
	}
	return folds;
}

function resolveSpan(menu: Menu, span: Span): Fold {
	const entries = menu.entries;
	const from = entries.find((entry) => entry.id === span.from);
	if (from === undefined)
		throw new Error(`"${span.from}" is not in the current list. Call compact() for the current one.`);
	const to = entries.find((entry) => entry.id === span.to);
	if (to === undefined)
		throw new Error(`"${span.to}" is not in the current list. Call compact() for the current one.`);
	const at = entries.indexOf(from);
	const end = entries.indexOf(to);
	if (end < at) throw new Error(`"to" (${to.id}) is before "from" (${from.id}).`);
	if (span.summary.trim() === "") throw new Error(`summary for ${from.id}–${to.id} cannot be empty.`);
	return { at, end, entries: entries.slice(at, end + 1), from: from.id, to: to.id, summary: span.summary };
}

/** The one step that cannot be undone by throwing. Everything that can fail has already run, so the
 * only way to get here half-applied is a session write failing mid-loop — and then the model is told
 * how many landed, rather than a bare failure for work that was done (C7). */
function applyAll(pi: ExtensionAPI, planned: Planned[]): void {
	let applied = 0;
	try {
		for (const { record } of planned) {
			pi.appendEntry<FoldBlock>("fold-block", record);
			applied++;
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${applied} of ${planned.length} spans were compacted, then this failed: ${reason}. Call compact() for the current list.`,
		);
	}
}

interface Planned {
	record: FoldBlock;
	taken: Msg[];
	fold: Fold;
}

// The span the model named is round-aligned, because the menu partitions the view by rounds, so what
// the fold removes is exactly what it covers (§6). `msgs` counts that, and an absorbed block is one
// message of it: its summary.
function plan(slots: Slot[], fold: Fold, id: string, toolCallId: string, sessionId: string): Planned {
	const entryIds = fold.entries.flatMap((entry) => entry.entryIds);
	const blockIds = fold.entries.flatMap((entry) => entry.blockIds);
	const covered = new Set(entryIds);
	const absorbed = new Set(blockIds);
	const taken = slots.filter(
		(slot) =>
			(slot.entryId !== undefined && covered.has(slot.entryId)) ||
			(slot.block !== undefined && absorbed.has(slot.block.id)),
	);
	return {
		fold,
		taken: taken.map((slot) => slot.message),
		record: {
			id,
			summary: fold.summary,
			entryIds,
			blockIds,
			dropToolCallIds: [toolCallId],
			msgs: taken.length,
			tokensBefore: taken.reduce((sum, slot) => sum + estimateTokens(slot.message), 0),
			tokensAfter: estimateTokens({
				role: "user",
				content: [{ type: "text", text: fold.summary }],
				timestamp: 0,
			}),
			originalPath: originalPath(sessionId, id),
			timestamp: Date.now(),
		},
	};
}

/** The same fold, for a person: no path, because /jobs-style detail is not what you are watching for. */
const foldForYou = (record: FoldBlock, fold: { from: string; to: string }): string =>
	`Compacted ${fold.from}–${fold.to} into ${record.id}. ` +
	`${shortTokens(record.tokensBefore)} → ${shortTokens(record.tokensAfter)}, ${record.msgs} messages replaced.`;

/** The menu, for a person: its size, never its 5.4K of rows. */
const menuForYou = (menu: Menu): string[] =>
	menu.entries.length === 0
		? ["Nothing is compactable yet."]
		: [`${menu.entries.length} entries listed, ~${shortTokens(menu.tokens)} compactable.`];

/** The tool row: the spans as asked for, in the order asked for, before any of them is validated. */
const named = (params: Params): string =>
	(params.spans ?? []).map((one) => `${one.from}–${one.to}`).join(", ");

function nextBlockNumber(branch: SessionEntry[]): number {
	let highest = 0;
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== "fold-block") continue;
		const number = Number((entry.data as FoldBlock).id.slice(1));
		if (number > highest) highest = number;
	}
	return highest + 1;
}
