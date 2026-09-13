import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { blocksDir } from "./dump.ts";
import { registerEmergency } from "./emergency.ts";
import { type FoldState, registerFold } from "./fold.ts";
import { log } from "./log.ts";
import { NAME, NUDGE_GROWTH_TOKENS, sendNudge } from "./nudge.ts";
import { projectSlots } from "./project.ts";
import { labelled, type Shown } from "./shown.ts";
import { liveBlocks } from "./state.ts";
import { setFoldStatus } from "./status.ts";
import type { FoldBlock } from "./types.ts";
import { buildView } from "./view.ts";

export default function contextFold(pi: ExtensionAPI): void {
	const state: FoldState = { menu: undefined, menuAt: 0, folded: false, baseline: 0, reported: new Set() };

	pi.on("context", (_event, ctx) => ({
		messages: projectSlots(
			buildView(ctx.sessionManager.buildContextEntries()),
			liveBlocks(ctx.sessionManager),
		).map((slot) => slot.message),
	}));

	pi.on("before_agent_start", (event, ctx) => ({
		systemPrompt: `${event.systemPrompt}\n\n${systemPrompt(ctx.sessionManager.getSessionId())}`,
	}));

	// Registered here, never inside a handler: pi catches a handler throw and carries on, so a tool
	// registered in `session_start` disappears for the whole session the first time anything there
	// fails — while the system prompt goes on saying it exists.
	registerFold(pi, state);
	registerEmergency(pi);

	pi.registerMessageRenderer<Shown>(NAME, (message, _options, theme) =>
		labelled(theme, NAME, message.details?.lines ?? []),
	);

	// Reporting and every decision happen here, never in the `context` handler, which stays a pure
	// projection with no I/O and no decisions (D2, D3).
	pi.on("turn_end", (_event, ctx) => {
		const blocks = liveBlocks(ctx.sessionManager);
		setFoldStatus(ctx, blocks);
		reportOrphans(ctx, state, blocks);
		nudge(pi, ctx, state);
	});
}

/** Decision 28's unusable record, noticed where a decision is allowed to happen (D2). A block with no
 * entry left in the view emits no summary; `compact` refuses any fold that would cause that, so
 * what reaches here is a compaction we did not make, or the overflow cut trading an anchor away. */
function reportOrphans(ctx: ExtensionContext, state: FoldState, blocks: FoldBlock[]): void {
	const present = new Set(ctx.sessionManager.buildContextEntries().map((entry) => entry.id));
	for (const block of blocks) {
		if (block.entryIds.some((id) => present.has(id)) || state.reported.has(block.id)) continue;
		state.reported.add(block.id);
		log("block-without-summary", { block: block.id, entries: block.entryIds.length });
	}
}

/**
 * Growth, not a fraction of the window (§8). The baseline starts at 0, so a resumed 800K session is
 * nudged on its first turn instead of needing 1.0M to reach a baseline it was born at. It follows
 * the number down and only rises on a nudge — a fold that reclaimed 712 tokens must not re-anchor at
 * 899K and silence the session until overflow (§17.9). It falls a turn late after a fold, which is
 * what the one-round pause covers.
 */
function nudge(pi: ExtensionAPI, ctx: ExtensionContext, state: FoldState): void {
	const usage = ctx.getContextUsage();
	// `null` right after a compaction, `undefined` with no model. Pi is honest about not knowing and
	// we inherit the honesty: there is no second meter to fall back on (§7).
	if (usage === undefined || usage.tokens === null) return;
	const predicted = usage.tokens;
	if (predicted < state.baseline) state.baseline = predicted;
	if (state.folded) {
		state.folded = false;
		return;
	}
	const growth = predicted - state.baseline;
	if (growth < NUDGE_GROWTH_TOKENS) return;

	// A nudge needs NUDGE_GROWTH_TOKENS of growth to fire, so with less than that left in the window
	// there is no room for another one: this is the last reminder before the context runs out (§7).
	const last = usage.contextWindow - predicted < NUDGE_GROWTH_TOKENS;
	// A turn of its own only for the last nudge, which has to be acted on before the next overflow.
	// An ordinary nudge reports and waits: it is read at the start of the next turn either way, and
	// waking the model to tell it that nothing is required costs a model call for nothing.
	sendNudge(pi, ctx, { last, trigger: last });
	state.baseline = predicted;
	log("nudge", { predicted, growth, last });
}

/** MODEL-FACING-TEXT.md §1, in every request. The folder line is the one habit worth its tokens everywhere. */
function systemPrompt(sessionId: string): string {
	return `### Context Management

You manage your own context. When it grows large you will be notified to compact some of your context. Compacting replaces older parts of the conversation with summaries you write. Compacting keeps the context lean which helps you to perform better. The compacted range and the summary are yours to decide. \`compact()\` with no arguments lists what can be compacted. The transcript you have compacted is written to \`${blocksDir(sessionId)}/\` as plain text, one file per compaction. Search that directory when you encounter an ambiguity or have a question, the answer is usually already there.`;
}
