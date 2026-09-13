import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildContextEntries,
	type ContextUsage,
	type FileEntry,
	parseSessionEntries,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { project } from "../src/project";
import { liveBlocks } from "../src/state";
import { setFoldStatus } from "../src/status";
import type { FoldBlock, Msg, ViewItem } from "../src/types";
import { buildView } from "../src/view";

const SESSION_DIR = "/home/rmng/.pi/agent/sessions/--home-rmng-RMNG--";

function sessionFiles(): string[] {
	return readdirSync(SESSION_DIR)
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(SESSION_DIR, name));
}

/** Pi's own parser and its own compaction-aware entry list, so the test cannot drift from Pi. */
function contextEntries(file: string): SessionEntry[] {
	const parsed: FileEntry[] = parseSessionEntries(readFileSync(file, "utf8"));
	return buildContextEntries(parsed.filter((entry): entry is SessionEntry => entry.type !== "session"));
}

function pickSession(want: string, matches: (view: ViewItem[]) => boolean): ViewItem[] {
	for (const file of sessionFiles()) {
		const view = buildView(contextEntries(file));
		if (matches(view)) return view;
	}
	throw new Error(`no recorded session has ${want}`);
}

function snapshot(view: ViewItem[]): string {
	return JSON.stringify(view.map((item) => item.message));
}

function toolCallIds(message: Msg): string[] {
	if (message.role !== "assistant") return [];
	return message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
}

function userText(message: Msg): string {
	assert.equal(message.role, "user", "expected the summary to be a user message");
	if (message.role !== "user") throw new Error("unreachable");
	const content = message.content;
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** PROMPTS.md §6's exact wrapper, for the fixed token numbers `block()` carries. */
function summaryOf(id: string, msgs: number, path: string): string {
	return `<summary block="${id}" msgs="${msgs}" tokens="412.0K→3.1K" original="${path}">\nfolded work\n</summary>`;
}

/**
 * `Msg` must cover every role Pi can project, or a `switch` in a later step silently mishandles
 * one. A narrower union fails to compile on the cases below; a wider one fails on `unreachable`;
 * a role Pi projects that this union does not name throws when the corpus is replayed through it.
 */
function roleOf(message: Msg): string {
	switch (message.role) {
		case "user":
		case "assistant":
		case "toolResult":
		case "custom":
		case "bashExecution":
		case "branchSummary":
		case "compactionSummary":
			return message.role;
		default: {
			const unreachable: never = message;
			throw new Error(`unhandled message role in ${JSON.stringify(unreachable)}`);
		}
	}
}

/** Invariant 3. Pi repairs orphan tool calls but not orphan results, so only this direction bites. */
function assertNoOrphanResults(messages: Msg[], label: string): void {
	const calls = new Set<string>();
	for (const message of messages) {
		for (const id of toolCallIds(message)) calls.add(id);
		if (message.role === "toolResult") {
			assert.ok(calls.has(message.toolCallId), `${label}: tool result ${message.toolCallId} has no call before it`);
		}
	}
}

/**
 * DESIGN §3's structural rule. pi-ai reads a non-tool message between a call and its result as the
 * tool flow being interrupted: it injects `{content: "No result provided", isError: true}` for the
 * call, so the model is told the call failed and the real result arrives as an orphan. A call with
 * no result at all is a different thing — pi-ai repairs that one — so it is not counted here.
 */
function assertNoStraddle(messages: Msg[], label: string): void {
	const resultAt = new Map<string, number>();
	for (const [index, message] of messages.entries()) {
		if (message.role === "toolResult") resultAt.set(message.toolCallId, index);
	}
	for (const [index, message] of messages.entries()) {
		for (const id of toolCallIds(message)) {
			const at = resultAt.get(id);
			if (at === undefined) continue;
			for (let between = index + 1; between < at; between++) {
				const role = (messages[between] ?? assert.fail(`${label}: no message at ${between}`)).role;
				assert.equal(role, "toolResult", `${label}: a ${role} message sits between call ${id} and its result`);
			}
		}
	}
}

/** Call id → the entry id of the tool result answering it. */
function resultEntries(view: ViewItem[]): Map<string, string> {
	const entries = new Map<string, string>();
	for (const item of view) {
		if (item.message.role === "toolResult") entries.set(item.message.toolCallId, item.entryId);
	}
	return entries;
}

/** Indices where a covered span may end: every call it makes is answered inside it (H2). */
function spanEnds(view: ViewItem[]): number[] {
	const pending = new Set<string>();
	const ends: number[] = [];
	for (const [index, item] of view.entries()) {
		for (const id of toolCallIds(item.message)) pending.add(id);
		if (item.message.role === "toolResult") pending.delete(item.message.toolCallId);
		if (pending.size === 0 && view[index + 1] !== undefined) ends.push(index);
	}
	return ends;
}

function block(fields: Partial<FoldBlock>): FoldBlock {
	return {
		id: "b1",
		summary: "folded work",
		entryIds: [],
		blockIds: [],
		dropToolCallIds: [],
		msgs: 0,
		tokensBefore: 412_000,
		tokensAfter: 3_100,
		originalPath: "/home/rmng/.cache/pi/context-fold/01a094/b1.txt",
		timestamp: 1_760_000_000_000,
		...fields,
	};
}

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "2026-09-12T00:00:00.000Z", customType, data };
}

function compactionEntry(id: string, parentId: string, firstKeptEntryId: string): SessionEntry {
	const timestamp = "2026-09-12T00:00:00.000Z";
	return { type: "compaction", id, parentId, timestamp, summary: "a later compaction", firstKeptEntryId, tokensBefore: 1 };
}

test("every recorded session replays to Pi's own bytes, twice, over every role Pi projects", () => {
	for (const file of sessionFiles()) {
		const entries = contextEntries(file);
		const expected = JSON.stringify(entries.flatMap(sessionEntryToContextMessages));
		const view = buildView(entries);

		// Invariant 2: the snapshot was taken before the pipeline ran, so a mutation shows up here.
		assert.equal(JSON.stringify(project(view, [])), expected, `${file}: view is not Pi's byte-for-byte`);
		// Invariant 7: same log, same state.
		assert.equal(JSON.stringify(project(buildView(entries), [])), expected, `${file}: second replay differs`);

		assertNoOrphanResults(
			view.map((item) => item.message),
			file,
		);
		for (const item of view) roleOf(item.message);
	}
});

/**
 * The entry ids are the view's only product, and every other test derives its ids from the view, so
 * any self-consistent labelling would pass them. Step 3 persists these ids into records that must
 * still resolve turns later, so each one is checked against the entry it was projected from.
 */
test("every view item carries its own entry's id, in entry order", () => {
	for (const file of sessionFiles()) {
		const entries = contextEntries(file);
		const ids = new Set(entries.map((entry) => entry.id));
		assert.ok([...ids].every((id) => id.length > 0), `${file}: an entry has an empty id`);
		const view = buildView(entries);

		let at = 0;
		for (const entry of entries) {
			for (const message of sessionEntryToContextMessages(entry)) {
				const item = view[at] ?? assert.fail(`${file}: the view stops at ${at}`);
				assert.ok(ids.has(item.entryId), `${file}: ${item.entryId} is not an id from buildContextEntries`);
				assert.equal(item.entryId, entry.id, `${file}: item ${at} names ${item.entryId}, not its entry`);
				assert.equal(JSON.stringify(item.message), JSON.stringify(message), `${file}: item ${at} holds another message`);
				at++;
			}
		}
		assert.equal(at, view.length, `${file}: the view holds items no entry projected`);
	}
});

test("a fold replaces its covered span with one summary", () => {
	const view = pickSession("three legal span ends", (candidate) => spanEnds(candidate).length >= 3);
	const end = spanEnds(view).at(-3) ?? assert.fail("no span end");
	const covered = view.slice(0, end + 1);
	const entryIds = [...new Set(covered.map((item) => item.entryId))];
	assert.equal(entryIds.length, covered.length, "one entry projected to more than one message");

	const before = snapshot(view);
	const folded = block({ entryIds, msgs: covered.length });
	const out = project(view, [folded]);

	// Invariant 1, counted in entries: output = input − covered + one summary.
	assert.equal(out.length, view.length - covered.length + 1);
	assert.equal(userText(out[0] ?? assert.fail("no summary emitted")), summaryOf("b1", covered.length, folded.originalPath));
	assert.deepEqual(
		out.slice(1),
		view.slice(end + 1).map((item) => item.message),
	);
	assertNoOrphanResults(out, "folded view");
	assert.equal(JSON.stringify(project(view, [folded])), JSON.stringify(out), "second projection differs");
	// Invariant 2 on the fold path: the snapshot predates the projection, so an in-place edit shows.
	assert.equal(snapshot(view), before, "the fold projection mutated an input message");

	// A compaction cut can take the head of a span out of the view; the summary still lands.
	const cutHead = block({ entryIds: ["gone-with-the-cut", ...entryIds], msgs: covered.length });
	assert.equal(JSON.stringify(project(view, [cutHead])), JSON.stringify(out), "a cut span loses its summary");
});

/**
 * `buildContextEntries` hoists the newest compaction entry to the front, so the view is not path
 * order and a span that was contiguous when it was folded can split once a later compaction lands.
 * Pi's own function builds the split here: a recorded session, path-ordered again, plus one more
 * compaction entry. Emitting the summary at the last covered entry would put it after the entry
 * the hoist moved into the middle of the block, which is why only the first covered entry is right.
 */
test("a block whose coverage a later compaction split emits its summary at the first covered entry", () => {
	const { path, hoisted } = pickCompacted();
	const leaf = path.at(-1) ?? assert.fail("empty path");
	const firstKept = path[0] ?? assert.fail("empty path");
	const view = buildView(buildContextEntries([...path, compactionEntry("later", leaf.id, firstKept.id)]));

	const cutAt = view.findIndex((item) => item.entryId === hoisted.id);
	const ends = spanEnds(view);
	const end = ends.find((index) => index > cutAt) ?? assert.fail("no span end after the hoisted entry");
	const start = (ends.filter((index) => index < cutAt - 1).at(-1) ?? -1) + 1;
	assert.ok(start < cutAt && cutAt < end, `span ${start}..${end} must straddle the hoisted entry ${cutAt}`);

	const covered = view.slice(start, end + 1).filter((item) => item.entryId !== hoisted.id);
	const coveredIds = new Set(covered.map((item) => item.entryId));
	const at = view.flatMap((item, index) => (coveredIds.has(item.entryId) ? [index] : []));
	const last = at.at(-1) ?? assert.fail("nothing covered");
	assert.notEqual(at.length, last - start + 1, "the coverage is contiguous, so this fixture proves nothing");

	const folded = block({ entryIds: [...coveredIds], msgs: covered.length });
	const out = project(view, [folded]);
	assert.equal(out.length, view.length - covered.length + 1, "the closure took more than the span");
	const summary = summaryOf("b1", covered.length, folded.originalPath);
	const summaryAt = out.findIndex((message) => message.role === "user" && userText(message) === summary);
	assert.equal(summaryAt, start, "the summary must land at the block's first covered entry");
	assert.deepEqual(
		out.filter((_, index) => index !== summaryAt),
		view.filter((item) => !coveredIds.has(item.entryId)).map((item) => item.message),
	);
	assertNoStraddle(out, "split coverage");
});

/** A recorded session's entries back in path order, with the compaction entry the view hoisted. */
function pickCompacted(): { path: SessionEntry[]; hoisted: SessionEntry } {
	for (const file of sessionFiles()) {
		const entries = contextEntries(file);
		const hoisted = entries[0];
		if (hoisted?.type !== "compaction") continue;
		const afterAt = entries.findIndex((entry) => entry.parentId === hoisted.id);
		if (afterAt < 2) continue;
		return { path: [...entries.slice(1, afterAt), hoisted, ...entries.slice(afterAt)], hoisted };
	}
	throw new Error("no recorded session keeps entries on both sides of a compaction entry");
}

test("a covered span closes over the call↔result pairing, in both directions", () => {
	const wanted = "a single-call assistant message answered by a later entry";
	const view = pickSession(wanted, (candidate) => splitPair(candidate) !== undefined);
	const [callIndex, resultIndex] = splitPair(view) ?? assert.fail(wanted);
	const callMessage = view[callIndex]?.message ?? assert.fail("no call message");
	const callEntry = view[callIndex]?.entryId ?? assert.fail("no call entry");
	const resultEntry = view[resultIndex]?.entryId ?? assert.fail("no result entry");
	const callId = toolCallIds(callMessage)[0] ?? assert.fail("no tool call id");

	const before = snapshot(view);
	const withoutCall = project(view, [block({ entryIds: [callEntry], msgs: 1 })]);
	assertNoOrphanResults(withoutCall, "call covered, result not");
	assert.equal(withoutCall.length, view.length - 1, "the result must go with its call");

	// Coverage extends to the call rather than shrinking to keep the result: shrinking emitted an
	// orphan result, and left a block that removed nothing and so emitted no summary.
	const out = project(view, [block({ entryIds: [resultEntry], msgs: 1 })]);
	assert.equal(out.filter((message) => toolCallIds(message).includes(callId)).length, 0, `call ${callId} survived`);
	assert.equal(
		out.filter((message) => message.role === "toolResult" && message.toolCallId === callId).length,
		0,
		`the covered result of ${callId} survived`,
	);
	assertNoOrphanResults(out, "result covered, call not");

	// The covered result takes the whole assistant message, not just its call block, so the summary
	// lands where that message was and the rest of the view follows it untouched.
	const summary = summaryOf("b1", 1, block({}).originalPath);
	const summaryIndex = out.findIndex((message) => message.role === "user" && userText(message) === summary);
	assert.equal(summaryIndex, callIndex, "the summary must land at the round's first covered entry");
	const coveredIds = new Set([callEntry, resultEntry]);
	assert.deepEqual(
		out.slice(summaryIndex + 1),
		view
			.slice(summaryIndex + 1)
			.filter((item) => !coveredIds.has(item.entryId))
			.map((item) => item.message),
	);
	assert.equal(out.length, view.length - 2 + 1, "wrong number of messages survived");
	assert.equal(snapshot(view), before, "the projection mutated an input message");
});

/** The first assistant message with exactly one answered tool call whose result is another entry. */
function splitPair(view: ViewItem[]): [number, number] | undefined {
	const resultIndex = new Map<string, number>();
	for (const [index, item] of view.entries()) {
		if (item.message.role === "toolResult") resultIndex.set(item.message.toolCallId, index);
	}
	for (const [index, item] of view.entries()) {
		const ids = toolCallIds(item.message);
		const first = ids.length === 1 ? ids[0] : undefined;
		const at = first === undefined ? undefined : resultIndex.get(first);
		if (at !== undefined && item.entryId !== view[at]?.entryId) return [index, at];
	}
	return undefined;
}

test("covering the entry that answers one of two sibling calls folds the whole round", () => {
	const wanted = "an assistant message with exactly two answered tool calls";
	const view = pickSession(wanted, (candidate) => twoCallRound(candidate) !== undefined);
	const [callIndex, first, second] = twoCallRound(view) ?? assert.fail(wanted);
	const answered = resultEntries(view).get(first) ?? assert.fail("no entry answers the first call");

	const before = snapshot(view);
	const folded = block({ entryIds: [answered], msgs: 1 });
	const out = project(view, [folded]);

	// Until the closure took the assistant message too, the sibling call survived and the summary
	// landed between it and its result. The closure makes the round the unit: all three go together.
	assertNoStraddle(out, "one of two results covered");
	assert.equal(out.filter((message) => toolCallIds(message).includes(second)).length, 0, `call ${second} survived`);
	assert.equal(out.filter((message) => message.role === "toolResult" && message.toolCallId === second).length, 0);
	assert.equal(out.length, view.length - 3 + 1, "the round is the assistant message and both results");
	assert.equal(userText(out[callIndex] ?? assert.fail("no summary emitted")), summaryOf("b1", 1, folded.originalPath));
	assert.equal(snapshot(view), before, "the projection mutated an input message");
});

/** The first assistant message with exactly two tool calls, both answered. */
function twoCallRound(view: ViewItem[]): [number, string, string] | undefined {
	const answered = resultEntries(view);
	for (const [index, item] of view.entries()) {
		const ids = toolCallIds(item.message);
		const [first, second] = ids;
		if (ids.length !== 2 || first === undefined || second === undefined) continue;
		if (answered.has(first) && answered.has(second)) return [index, first, second];
	}
	return undefined;
}

test("retiring one tool call keeps its assistant message and the sibling call it still holds", () => {
	const wanted = "an assistant message with thinking and two answered tool calls";
	const view = pickSession(wanted, (candidate) => answeredMultiCall(candidate) !== undefined);
	const [original, dropped, sibling] = answeredMultiCall(view) ?? assert.fail(wanted);

	const before = snapshot(view);
	const out = project(view, [block({ dropToolCallIds: [dropped], msgs: 1 })]);
	const survivor = out.find((message) => toolCallIds(message).includes(sibling));

	// Invariant 4: the message stays, minus the retired call; its thinking goes with it (§6).
	assert.ok(survivor, `assistant message holding ${sibling} was removed`);
	assert.deepEqual(
		toolCallIds(survivor),
		toolCallIds(original).filter((id) => id !== dropped),
	);
	if (survivor.role !== "assistant") throw new Error("unreachable");
	assert.equal(
		survivor.content.some((item) => item.type === "thinking"),
		false,
	);
	assert.equal(out.filter((message) => message.role === "toolResult" && message.toolCallId === dropped).length, 0);
	assert.equal(out.filter((message) => message.role === "toolResult" && message.toolCallId === sibling).length, 1);
	assert.equal(out.length, view.length - 1, "only the retired call's result should go");
	assertNoOrphanResults(out, "rewritten view");
	assert.equal(snapshot(view), before, "the rewrite mutated an input message");
});

/** The first assistant message that carries thinking and two tool calls that both got results. */
function answeredMultiCall(view: ViewItem[]): [Msg, string, string] | undefined {
	const answered = resultEntries(view);
	for (const item of view) {
		const message = item.message;
		if (message.role !== "assistant") continue;
		if (!message.content.some((part) => part.type === "thinking")) continue;
		const ids = toolCallIds(message).filter((id) => answered.has(id));
		if (ids.length >= 2 && ids[0] && ids[1]) return [message, ids[0], ids[1]];
	}
	return undefined;
}

test("fold-block records read back from the branch, and absorbing a block takes over its entries", () => {
	const first = block({ id: "b1", entryIds: ["a", "b"], msgs: 2 });
	const second = block({ id: "b2", entryIds: ["c"], blockIds: ["b1"], msgs: 3 });
	const third = block({ id: "b3", entryIds: ["d"], blockIds: ["b2"], msgs: 4 });
	const entries: SessionEntry[] = [
		customEntry("foreign", "pi-todo-state", undefined),
		customEntry("e1", "fold-block", first),
		customEntry("e2", "fold-block", second),
	];

	const live = liveBlocks({ getBranch: () => entries });
	assert.deepEqual(liveBlocks({ getBranch: () => entries }), live, "second read differs");

	// Without the union, folding b1's summary into b2 would put everything behind b1 back in the view.
	assert.deepEqual(
		live.map((item) => item.id),
		["b2"],
	);
	assert.deepEqual([...(live[0] ?? assert.fail("b2 is not live")).entryIds].sort(), ["a", "b", "c"]);

	entries.push(customEntry("e3", "fold-block", third));
	const chained = liveBlocks({ getBranch: () => entries });
	assert.deepEqual(
		chained.map((item) => item.id),
		["b3"],
	);
	assert.deepEqual([...(chained[0] ?? assert.fail("b3 is not live")).entryIds].sort(), ["a", "b", "c", "d"]);
});

test("the status line is DESIGN §6: one context number, Pi's, and `?` when Pi has none", () => {
	const shown: string[] = [];
	const ctx = (usage: ContextUsage | undefined) => ({
		ui: { setStatus: (key: string, text: string | undefined) => shown.push(`${key}|${text}`) },
		getContextUsage: () => usage,
	});
	const blocks: FoldBlock[] = [
		block({ id: "b1", tokensBefore: 200_000, tokensAfter: 2_000 }),
		block({ id: "b2", tokensBefore: 120_000, tokensAfter: 6_000 }),
	];

	setFoldStatus(ctx({ tokens: 640_000, contextWindow: 1_000_000, percent: 64 }), blocks);
	assert.equal(shown[0], "fold|fold  2 blocks · 312K folded · 640K / 1.0M");

	// Both absences are Pi's own: `tokens` is null right after a compaction, the whole result is
	// undefined with no model. Neither may be reported as a number.
	setFoldStatus(ctx({ tokens: null, contextWindow: 1_000_000, percent: null }), blocks);
	assert.equal(shown[1], "fold|fold  2 blocks · 312K folded · ?");
	setFoldStatus(ctx(undefined), blocks);
	assert.equal(shown[2], "fold|fold  2 blocks · 312K folded · ?");
});
