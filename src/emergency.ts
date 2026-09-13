import {
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { messageText, writeOverflow } from "./dump.ts";
import { log } from "./log.ts";
import { rounds } from "./menu.ts";
import { sendNudge } from "./nudge.ts";
import { projectSlots, shortTokens, summaryMessage } from "./project.ts";
import { liveBlocks } from "./state.ts";
import type { FoldBlock, Msg, Slot, ViewItem } from "./types.ts";
import { buildView } from "./view.ts";

/** §8. Pi's own compaction summarises the raw history, which on a folded session overflows on the
 * summarisation call itself (D5), so its summariser must never run: ordinary pressure is cancelled,
 * a real overflow is answered with a mechanical cut, and nothing here throws.
 * No model call, so there is no timeout, no rate limit and no fallback for either. */
export function registerEmergency(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event, ctx) => {
		if (event.reason === "threshold") return { cancel: true };
		// `/compact` cannot be removed from Pi, so it is answered rather than obeyed (§7b). Pi's
		// summariser is cancelled and the model is asked, in the ordinary nudge's words, to compact
		// itself — with a turn of its own, because you pressed a key and expect something to happen.
		// The mechanical cut is kept for "overflow", where there is no turn left to ask in.
		if (event.reason === "manual") {
			sendNudge(pi, ctx, { last: false, trigger: true });
			log("manual-compact", {});
			return { cancel: true };
		}
		const compaction = recover(event, ctx);
		try {
			log("emergency", { reason: event.reason, keptFrom: compaction.firstKeptEntryId });
		} catch {
			// The one error this project drops. Rethrowing it would hand the turn to Pi's summariser.
		}
		return { compaction };
	});
}

function recover(event: SessionBeforeCompactEvent, ctx: ExtensionContext): CompactionResult {
	const view = buildView(ctx.sessionManager.buildContextEntries());
	const blocks = liveBlocks(ctx.sessionManager);
	const slots = projectSlots(view, blocks);
	const at = halfway(slots);
	const firstKeptEntryId = afterCut(view, slots, at);
	const cut = slots.slice(0, at).map((slot) => slot.message);
	const kept = new Set(
		view.slice(view.findIndex((item) => item.entryId === firstKeptEntryId)).map((item) => item.entryId),
	);
	const orphaned = blocks.filter((block) => !block.entryIds.some((id) => kept.has(id)));
	const tokens = cut.reduce((sum, message) => sum + estimateTokens(message), 0);
	return {
		summary: note(ctx, cut, tokens, orphaned),
		firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
	};
}

/** The first slot to keep: the earliest round boundary that frees at least half the view's tokens,
 * and the last boundary when none of them does — keeping only the newest round, the most relief
 * available. Boundaries, because a cut inside a round keeps a tool result whose call it removed
 * (H2), the one direction pi-ai does not repair. The fallback is not a nicety: measured live, a
 * model put six tool calls in one assistant message, so one round held 8 of the view's 9 messages. */
function halfway(slots: Slot[]): number {
	const total = slots.reduce((sum, slot) => sum + estimateTokens(slot.message), 0);
	let at = 0;
	let last = 0;
	let freed = 0;
	for (const round of rounds(slots)) {
		if (freed * 2 >= total) return at;
		last = at;
		freed += round.reduce((sum, slot) => sum + estimateTokens(slot.message), 0);
		at += round.length;
	}
	return last;
}

/** The entry after the last one being cut — not the first kept slot's entry, because the entries
 * between them are already folded away and keeping them costs nothing while it saves their blocks.
 * A view with no boundary to cut at keeps everything, and Pi reports the failure in its own words:
 * a throw would hand the turn to its raw summariser, which is the overflow D5 exists to prevent. */
function afterCut(view: ViewItem[], slots: Slot[], at: number): string {
	const last = slots.slice(0, at).findLast((slot) => slot.entryId !== undefined)?.entryId;
	const next =
		last === undefined ? undefined : view[view.findLastIndex((item) => item.entryId === last) + 1];
	// Pi skips this hook when it has nothing to compact, so the view always has a first entry.
	return (next ?? view[0]!).entryId;
}

/** PROMPTS.md §8. Says what happened, that it was not summarised, and where the content is. The
 * write is the only thing left that can fail, and §8 keeps the compaction either way (C10). */
function note(ctx: ExtensionContext, cut: Msg[], tokens: number, orphaned: FoldBlock[]): string {
	const size = `${cut.length.toLocaleString("en-US")} messages`;
	try {
		const path = writeOverflow(ctx.sessionManager.getSessionId(), Date.now(), cut);
		const head =
			`This session overflowed its context window, so the older half was removed from view rather ` +
			`than summarised. Those ${size} (~${shortTokens(tokens)} tokens) were written verbatim to ` +
			`${path} — read or grep that file to retrieve any of it — or read the session log at ` +
			`${ctx.sessionManager.getSessionFile()}, which still holds every message.`;
		if (orphaned.length === 0) return head;
		return [
			`${head} Summaries you wrote for compacted spans in that half are reproduced below.`,
			...orphaned.map((block) => messageText(summaryMessage(block))),
		].join("\n\n");
	} catch (error) {
		return (
			`This session overflowed its context window, so the older half — ${size}, ~${shortTokens(tokens)} ` +
			`tokens — was removed from view. Writing it to a file failed (${error instanceof Error ? error.message : String(error)}); the content ` +
			`remains in the session log at ${ctx.sessionManager.getSessionFile()}.`
		);
	}
}
