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
 * MODEL-FACING-TEXT.md §7. `growth` is the ordinary reminder, which waits for the next turn; `last`
 * is §7a, the one sent when no second reminder can fire; `manual` is §7b, the answer to `/compact`.
 * The last two start a turn of their own when the model is idle: something has to happen before the
 * window fills, or because you pressed a key. While it runs, all three are read at its next call.
 */
export type NudgeKind = "growth" | "last" | "manual";

/** What a nudge carries besides its text: the TUI lines, and which of the three it is, so a fold can
 * tell a run that exists only to compact from a run doing your work (`fold.ts`). */
export interface NudgeDetails extends Shown {
	kind: NudgeKind;
}

/**
 * The one place a nudge is sent from: the growth clock (§8) and `/compact` (§7b) both arrive here.
 * When to send, and what the growth clock does afterwards, is the caller's business.
 */
export function sendNudge(pi: ExtensionAPI, ctx: ExtensionContext, kind: NudgeKind, growth: number): void {
	const usage = ctx.getContextUsage();
	// `null` right after a compaction, `undefined` with no model. Pi is honest about not knowing and
	// we inherit the honesty: the sentence is dropped rather than filled with a second meter (§7).
	const used =
		usage === undefined || usage.tokens === null
			? undefined
			: `${shortTokens(usage.tokens)} of ${shortTokens(usage.contextWindow)} context used.`;
	const lines = kind === "last" ? ["Last reminder before the context runs out."] : [];
	pi.sendMessage<NudgeDetails>(
		{
			customType: NAME,
			content: `<${NAME}>\n${nudgeText(kind, used, growth)}\n</${NAME}>`,
			details: { lines: used === undefined ? lines : [used, ...lines], kind },
			display: true,
		},
		// A steer, every kind: read at the model's next call, mid-task or not. The growth reminder
		// starts nothing; the other two start a run when none is going.
		{ deliverAs: "steer", triggerTurn: kind !== "growth" },
	);
}

/** MODEL-FACING-TEXT.md §7, §7a and §7b, between the tags. The three share their sentences, so a
 * change to one wording is a change to every message that says it. `used` is left out when Pi does
 * not know the context size; §7b never states it, because the user asked and the number is not
 * what the request is about. */
export function nudgeText(kind: NudgeKind, used: string | undefined, growth: number): string {
	const how = `\`compact()\` with no arguments to list the spans and the summary writing instructions, then choose the span to compact.`;
	const reminder = (next: string) => [REMINDER, used, next].filter(Boolean).join(" ");
	switch (kind) {
		case "growth":
			return [
				reminder(`You will be reminded again after another ${shortTokens(growth)} of growth.`),
				`${WHY}\nCompact if there is a large chunk of finished work in the way: ${FINISHED} If nothing qualifies, carry on with the work.`,
				`To compact, call ${how}`,
			].join("\n\n");
		case "last":
			return [
				reminder("This is the last reminder before this session runs out of context."),
				`Compact large chunks of finished work: ${FINISHED}`,
				`Compact as soon as possible. Call ${how}`,
			].join("\n\n");
		case "manual":
			return [
				`The user has requested you to perform a compaction. ${WHY}`,
				`Compact large chunks of finished work: ${FINISHED}`,
				`To compact, call ${how}`,
			].join("\n\n");
	}
}

/** MODEL-FACING-TEXT.md §7. The first sentence of both reminders. */
const REMINDER = "This is a reminder that you handle the context compaction yourself.";

/** MODEL-FACING-TEXT.md §1 and §7. Why compacting is worth it, and whose choice it is: said in the
 * system prompt, and again wherever the model is asked to compact. */
export const WHY =
	"Compacting keeps the context lean which helps you to perform better. The compacted range and the summary are yours to decide.";

/** MODEL-FACING-TEXT.md §7. What counts as finished work, in every message that asks for a fold. The
 * rules for picking the span and writing the summary stay in the menu, where they are read at the
 * moment they apply (§3a). */
const FINISHED =
	"exploration that led nowhere, tool output you have already used, a phase whose result is recorded.";
