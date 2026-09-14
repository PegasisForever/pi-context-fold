import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NUDGE_CUSTOM_TYPE as NAME, shortTokens } from "./project.ts";
import type { Shown } from "./shown.ts";

/** The tag on every message this extension injects, and the name on every renderer it registers. */
export { NAME };

/**
 * Nudge once the context has grown by this much since the last nudge (§8). The default, and the only
 * thing `settings.json` can change: measured on three days of one machine's sessions and never since,
 * which is what earns it a key where nothing else here has one (§13, C9).
 */
export const NUDGE_GROWTH_TOKENS = 200_000;

/**
 * The one place a nudge is sent from: the growth clock (§8) and `/compact` (§7b) both arrive here.
 * When to send, and what the growth clock does afterwards, is the caller's business.
 */
export function sendNudge(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { last: boolean; trigger: boolean; growth: number },
): void {
	const usage = ctx.getContextUsage();
	// `null` right after a compaction, `undefined` with no model. Pi is honest about not knowing and
	// we inherit the honesty: the sentence is dropped rather than filled with a second meter (§7).
	const used =
		usage === undefined || usage.tokens === null
			? undefined
			: `${shortTokens(usage.tokens)} of ${shortTokens(usage.contextWindow)} context used.`;
	const body = options.last ? LAST_NUDGE : nudgeBody(options.growth);
	const lines = options.last ? ["Last reminder before the context runs out."] : [];
	pi.sendMessage<Shown>(
		{
			customType: NAME,
			content: `<${NAME}>\n${[REMINDER, used, body].filter(Boolean).join(" ")}\n</${NAME}>`,
			details: { lines: used === undefined ? lines : [used, ...lines] },
			display: true,
		},
		{ deliverAs: "followUp", triggerTurn: options.trigger },
	);
}

/** MODEL-FACING-TEXT.md §7. The first sentence of every nudge, before the two that differ. */
const REMINDER = "This is a reminder that you handle the context compaction yourself.";

/**
 * MODEL-FACING-TEXT.md §7. A report, not an order: it says what the pressure is and hands the
 * decision back. What it carries is what the model needs to decide *whether* to compact, which it
 * cannot get from the menu without paying 5.4K tokens for it first. The rules for picking the span
 * and writing the summary stay in the menu, where they are read at the moment they apply (§3a).
 */
const nudgeBody = (
	growth: number,
) => `You will be reminded again after another ${shortTokens(growth)} of growth.

You do not have to compact after this message, compact only if there is a large chunk of finished work in the way: exploration that led nowhere, tool output you have already used, a phase whose result is recorded. If nothing qualifies, carry on with the work.

You can choose to compact at any time you see fit. To compact, call \`compact()\` with no arguments to list the spans and the summary writing instructions, then choose the span to compact.`;

/** MODEL-FACING-TEXT.md §7a. The same reminder when no second one can fire, so it asks for the fold. */
const LAST_NUDGE = `This is the last reminder before this session runs out of context.

Compact as soon as possible. Call \`compact()\` with no arguments to list the spans and the summary writing instructions, then choose the span to compact.`;
