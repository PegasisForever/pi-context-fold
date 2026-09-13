import { type ExtensionAPI, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { originalPath, writeOriginal } from "./dump.ts";
import { log } from "./log.ts";
import { buildMenu, type Menu, type MenuEntry } from "./menu.ts";
import { noArguments, projectSlots, shortTokens, TOOL_NAME } from "./project.ts";
import { header, type Shown, shown } from "./shown.ts";
import { liveBlocks } from "./state.ts";
import type { FoldBlock, Msg, Slot } from "./types.ts";
import { buildView } from "./view.ts";

const parameters = Type.Object({
	from: Type.Optional(
		Type.String({ description: 'first entry of the span, e.g. "e3". From the list compress() returns.' }),
	),
	to: Type.Optional(Type.String({ description: "last entry of the span, inclusive. At or after from." })),
	summary: Type.Optional(Type.String({ description: "replaces the span. No length limit." })),
});

type Span = Static<typeof parameters>;

/** One span, resolved against the menu it names: the entries it covers and its own validated fields. */
interface Fold {
	entries: MenuEntry[];
	from: string;
	to: string;
	summary: string;
}

/** What survives between calls: the menu the ids belong to, and whether this round folded. */
export interface FoldState {
	menu: Menu | undefined;
	folded: boolean;
	baseline: number;
	reported: Set<string>;
}

// The one tool (§6). No arguments returns the menu; arguments fold. Arguments are Pi's own parse and
// schema validation, with no `prepareArguments` shim: lenient parsing exists in the original for a
// Qwen in non-strict tool mode and a local quantised 27B, which C2 excludes.
export function registerCompress(pi: ExtensionAPI, state: FoldState): void {
	pi.registerTool<typeof parameters, Shown>({
		name: TOOL_NAME,
		label: "Compress",
		description:
			"Fold one span of older conversation into a summary you write, freeing context. Call with no arguments to list what can be folded.",
		parameters,
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const view = buildView(ctx.sessionManager.buildContextEntries());
			const blocks = liveBlocks(ctx.sessionManager);
			if (noArguments(params)) {
				state.menu = buildMenu(view, blocks);
				return {
					content: [{ type: "text", text: state.menu.text }],
					// The menu costs ~5.4K tokens and reads as a wall of ids. You get the size of it.
					details: { lines: menuForYou(state.menu) },
				};
			}

			const fold = resolve(state.menu, params);
			const sessionId = ctx.sessionManager.getSessionId();
			const slots = projectSlots(view, blocks);
			const id = `b${nextBlockNumber(ctx.sessionManager.getBranch())}`;
			const { record, taken } = plan(slots, fold, id, toolCallId, sessionId);
			// C7. A fold against a menu the view has moved past replaces nothing: it would report a
			// success, write a zero-byte original and drop the summary the model just wrote. Reversing
			// the span produces the same empty plan, so one condition answers both (§5).
			if (taken.length === 0) {
				throw new Error(
					`Folding ${fold.from}–${fold.to} would replace nothing: the list is out of date. Call compress() for the current one.`,
				);
			}

			// The log goes first. `appendFileSync` can throw, and after the two writes below that
			// would report a failure for a fold which had in fact been applied.
			log("fold", {
				block: record.id,
				msgs: record.msgs,
				tokensBefore: record.tokensBefore,
				tokensAfter: record.tokensAfter,
			});
			// The one measurement with no decision attached: the fold still happens.
			if (record.tokensAfter >= record.tokensBefore) log("fold-grew", { block: record.id });
			writeOriginal(sessionId, record.id, taken);
			pi.appendEntry<FoldBlock>("fold-block", record);
			state.menu = undefined;
			state.folded = true;
			return {
				content: [{ type: "text", text: resultLine(record, fold.from, fold.to) }],
				details: { lines: foldForYou(record, fold.from, fold.to) },
			};
		},
		renderCall: (params, theme) =>
			header(theme, TOOL_NAME, noArguments(params) ? undefined : `${params.from}–${params.to}`),
		renderResult: (result, _options, theme) => shown(result, theme),
	});
}

/** PROMPTS.md §5. Each failure names the id and the next action; none of them returns the menu. */
function resolve(menu: Menu | undefined, span: Span): Fold {
	const entries = menu?.entries ?? [];
	const from = entries.find((entry) => entry.id === span.from);
	if (from === undefined)
		throw new Error(`"${span.from}" is not in the current list. Call compress() for the current one.`);
	const to = entries.find((entry) => entry.id === span.to);
	if (to === undefined)
		throw new Error(`"${span.to}" is not in the current list. Call compress() for the current one.`);
	const at = entries.indexOf(from);
	const end = entries.indexOf(to);
	if (end < at) throw new Error(`"to" (${to.id}) is before "from" (${from.id}).`);
	if (span.summary === undefined || span.summary.trim() === "")
		throw new Error("summary is required and cannot be empty.");
	return { entries: entries.slice(at, end + 1), from: from.id, to: to.id, summary: span.summary };
}

// The span the model named is round-aligned, because the menu partitions the view by rounds, so what
// the fold removes is exactly what it covers (§6). `msgs` counts that, and an absorbed block is one
// message of it: its summary.
function plan(
	slots: Slot[],
	fold: Fold,
	id: string,
	toolCallId: string,
	sessionId: string,
): { record: FoldBlock; taken: Msg[] } {
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

/** PROMPTS.md §4: the block id, the real span, and the path. */
export function resultLine(record: FoldBlock, from: string, to: string): string {
	return (
		`Folded ${from}–${to} into ${record.id}. ` +
		`${shortTokens(record.tokensBefore)} → ${shortTokens(record.tokensAfter)}, ${record.msgs} messages replaced. ` +
		`Original: ${record.originalPath}`
	);
}

/** The same fold, for a person: no path, because /jobs-style detail is not what you are watching for. */
const foldForYou = (record: FoldBlock, from: string, to: string): string[] => [
	`Folded ${from}–${to} into ${record.id}.`,
	`${shortTokens(record.tokensBefore)} → ${shortTokens(record.tokensAfter)}, ${record.msgs} messages replaced.`,
];

/** The menu, for a person: its size, never its 5.4K of rows. */
const menuForYou = (menu: Menu): string[] =>
	menu.entries.length === 0
		? ["Nothing is foldable yet."]
		: [`${menu.entries.length} entries listed, ~${shortTokens(menu.tokens)} foldable.`];

function nextBlockNumber(branch: SessionEntry[]): number {
	let highest = 0;
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== "fold-block") continue;
		const number = Number((entry.data as FoldBlock).id.slice(1));
		if (number > highest) highest = number;
	}
	return highest + 1;
}
