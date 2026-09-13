import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FoldState, registerCompress } from "./compress";
import { type Config, DEFAULTS, loadConfig } from "./config";
import { registerEmergency } from "./emergency";
import { log, logDebug } from "./log";
import { buildMenu } from "./menu";
import { projectSlots, shortTokens } from "./project";
import { liveBlocks } from "./state";
import { setFoldStatus } from "./status";
import type { FoldBlock } from "./types";
import { buildView } from "./view";

export default function contextFold(pi: ExtensionAPI): void {
	const state: FoldState = { menu: undefined, folded: false, baseline: 0, config: DEFAULTS, reported: new Set() };

	pi.on("context", (_event, ctx) => ({
		messages: projectSlots(buildView(ctx.sessionManager.buildContextEntries()), liveBlocks(ctx.sessionManager)).map(
			(slot) => slot.message,
		),
	}));

	pi.on("before_agent_start", (event, ctx) => ({
		systemPrompt: `${event.systemPrompt}\n\n${systemPrompt(ctx.sessionManager.getSessionId())}`,
	}));

	registerCompress(pi, state);
	registerEmergency(pi, state);

	// §13, read once. A throw here reaches the user as `Extension error (<path>): …` — measured, in
	// both print and interactive mode — and the session then runs on the defaults.
	pi.on("session_start", (_event, ctx) => {
		state.config = loadConfig(ctx.sessionManager.getCwd());
	});

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
 * entry left in the view emits no summary; `compress` refuses any fold that would cause that, so
 * what reaches here is a compaction we did not make, or the overflow cut trading an anchor away. */
function reportOrphans(ctx: ExtensionContext, state: FoldState, blocks: FoldBlock[]): void {
	const present = new Set(ctx.sessionManager.buildContextEntries().map((entry) => entry.id));
	for (const block of blocks) {
		if (block.entryIds.some((id) => present.has(id)) || state.reported.has(block.id)) continue;
		state.reported.add(block.id);
		log(state.config, "block-without-summary", { block: block.id, entries: block.entryIds.length });
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
	if (growth < state.config.nudgeGrowthTokens) {
		logDebug(state.config, "quiet", { predicted, baseline: state.baseline });
		return;
	}

	const menu = buildMenu(buildView(ctx.sessionManager.buildContextEntries()), liveBlocks(ctx.sessionManager));
	const pressure = `${shortTokens(predicted)} of ${shortTokens(usage.contextWindow)} used, +${shortTokens(growth)} since the last check.`;
	const foldable = `~${shortTokens(menu.tokens)} foldable in ${menu.entries.length} entries.`;
	pi.sendMessage(
		{
			customType: "context-fold-nudge",
			content: [
				{
					type: "text",
					text: `<context-manager>\n${pressure} ${foldable}\n\nCall compress() for the list and the rules for using it.\n</context-manager>`,
				},
			],
			display: true,
		},
		{ triggerTurn: false },
	);
	state.baseline = predicted;
	log(state.config, "nudge", { predicted, growth, foldable: menu.tokens, entries: menu.entries.length });
}

/** PROMPTS.md §1, in every request. The folder line is the one habit worth its tokens everywhere. */
function systemPrompt(sessionId: string): string {
	return `### Context

This session manages its own context. When it grows large you will be asked to fold
older parts of the conversation into summaries you write. \`compress()\` with no arguments
lists what can be folded.

Everything you have folded in this session is written to
\`~/.cache/pi/context-fold/${sessionId}/\` as plain text, one file per block. Search that folder before
you ask the user to repeat something — the answer is usually already there.`;
}
