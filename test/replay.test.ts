import assert from "node:assert/strict";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildContextEntries,
	type CompactionResult,
	type ContextUsage,
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens,
	type FileEntry,
	parseSessionEntries,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	sessionEntryToContextMessages,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resultLine } from "../src/compress.ts";
import { loadConfig } from "../src/config.ts";
import { messageText } from "../src/dump.ts";
import contextFold from "../src/index.ts";
import { buildMenu, EMPTY, INSTRUCTION, rounds } from "../src/menu.ts";
import { projectSlots, shortTokens, staleMenuCalls, summaryMessage } from "../src/project.ts";
import { liveBlocks } from "../src/state.ts";
import { setFoldStatus } from "../src/status.ts";
import type { FoldBlock, Msg, ViewItem } from "../src/types.ts";
import { buildView } from "../src/view.ts";

const SESSION_DIR = "/home/rmng/.pi/agent/sessions/--home-rmng-RMNG--";

// Every dump this suite writes lands under its own home. `~/.cache/pi/context-fold/overflow/` is
// where a real overflow dump lands, and 488 files from earlier runs had collected there.
const REAL_HOME = homedir();

/** The loader reads `getAgentDir()` on every call, so the suite must too, not a cached path. */
const agentDir = (): string => join(homedir(), ".pi", "agent");
process.env.HOME = mkdtempSync(join(tmpdir(), "context-fold-home-"));

/** The projection under test; every assertion below is about the messages it emits. */
function project(view: ViewItem[], blocks: FoldBlock[]): Msg[] {
	return projectSlots(view, blocks).map((slot) => slot.message);
}

function sessionFiles(): string[] {
	return readdirSync(SESSION_DIR)
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(SESSION_DIR, name));
}

const TEXT = readFileSync(new URL("../docs/MODEL-FACING-TEXT.md", import.meta.url), "utf8");

/**
 * DESIGN §13a: MODEL-FACING-TEXT.md is the contract for every string the model sees, so the suite reads them
 * from it. A literal copied into this file lets the code and the document drift apart silently, and
 * the audit found seven sections doing exactly that.
 */
function section(number: string): string {
	const at = TEXT.indexOf(`\n## ${number}.`);
	assert.notEqual(at, -1, `MODEL-FACING-TEXT.md has no §${number}`);
	const end = TEXT.indexOf("\n## ", at + 1);
	return TEXT.slice(at, end === -1 ? TEXT.length : end);
}

/** The nth blockquote of a section, as the model reads it: the `> ` markers gone, wrapping kept. */
function quoted(number: string, nth = 0): string {
	const blocks = section(number).match(/(?:^>.*\n)+/gm) ?? [];
	const block = blocks[nth] ?? assert.fail(`MODEL-FACING-TEXT.md §${number} has no blockquote ${nth}`);
	return unmark(block).trimEnd();
}

/** The nth fenced block of a section. */
function fenced(number: string, nth = 0): string {
	const blocks = [...section(number).matchAll(/^```\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? "");
	return (
		blocks[nth] ?? assert.fail(`MODEL-FACING-TEXT.md §${number} has no fenced block ${nth}`)
	).trimEnd();
}

/** §8 wraps each of its two notes across four lines and quotes it, so the string is the backticks'
 * content with the document's own wrapping removed. */
function note(nth: number): string {
	const text = quoted("8", nth);
	return flat(
		/`([^`]+)`/s.exec(text)?.[1] ??
			assert.fail(`MODEL-FACING-TEXT.md §8 blockquote ${nth} quotes no note`),
	);
}

/** A cell of §5's failure table, named by the case in its first column. */
function failure(label: string): string {
	const row =
		section("5")
			.split("\n")
			.find((line) => line.startsWith(`| ${label} |`)) ?? assert.fail(`§5 has no "${label}" row`);
	return (row.split("|")[2] ?? "").trim().replace(/`/g, "");
}

function unmark(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/^> ?/, ""))
		.join("\n");
}

function flat(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The document's own text as a pattern: every word of MODEL-FACING-TEXT.md is pinned and only the values it
 * shows as examples are loosened, for the two — a dump path's timestamp and an `fs` error — that the
 * run alone knows. A document edit moves the example out from under `fills` and fails here.
 */
function asPattern(text: string, fills: [string, string][]): RegExp {
	let pattern = escaped(text);
	for (const [example, value] of fills) {
		assert.ok(
			pattern.includes(escaped(example)),
			`MODEL-FACING-TEXT.md no longer shows ${JSON.stringify(example)}`,
		);
		pattern = pattern.replace(escaped(example), value);
	}
	return new RegExp(`^${pattern}$`);
}

function escaped(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pi's own parser and its own compaction-aware entry list, so the test cannot drift from Pi. */
const parsed = new Map<string, SessionEntry[]>();
function contextEntries(file: string): SessionEntry[] {
	const seen = parsed.get(file);
	if (seen !== undefined) return seen;
	const entries: FileEntry[] = parseSessionEntries(readFileSync(file, "utf8"));
	const built = buildContextEntries(
		entries.filter((entry): entry is SessionEntry => entry.type !== "session"),
	);
	parsed.set(file, built);
	return built;
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

/** MODEL-FACING-TEXT.md §6's own wrapper, refilled for the fixed token numbers `block()` carries. */
function summaryOf(id: string, msgs: number, path: string): string {
	return fenced("6")
		.replace('block="b5"', `block="${id}"`)
		.replace('msgs="38"', `msgs="${msgs}"`)
		.replace('original="~/.pi/agent/context-fold/01a094/b5.txt"', `original="${path}"`)
		.replace("…the model's summary text…", "folded work");
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
			assert.ok(
				calls.has(message.toolCallId),
				`${label}: tool result ${message.toolCallId} has no call before it`,
			);
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
				assert.equal(
					role,
					"toolResult",
					`${label}: a ${role} message sits between call ${id} and its result`,
				);
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
		originalPath: "/home/rmng/.pi/agent/context-fold/01a094/b1.txt",
		timestamp: 1_760_000_000_000,
		...fields,
	};
}

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "2026-09-12T00:00:00.000Z", customType, data };
}

function compactionEntry(id: string, parentId: string, firstKeptEntryId: string): SessionEntry {
	const timestamp = "2026-09-12T00:00:00.000Z";
	return {
		type: "compaction",
		id,
		parentId,
		timestamp,
		summary: "a later compaction",
		firstKeptEntryId,
		tokensBefore: 1,
	};
}

test("every recorded session replays to Pi's own bytes, twice, over every role Pi projects", () => {
	let checked = 0;
	for (const file of sessionFiles()) {
		const entries = contextEntries(file);
		const expected = JSON.stringify(entries.flatMap(sessionEntryToContextMessages));
		const view = buildView(entries);
		const out = JSON.stringify(project(view, []));

		// Nine recorded sessions ran under the extension this one replaces, whose tool is also named
		// `compress` and carried its span in `content`. Reading those 27 calls as ours retired 54 real
		// messages: §8 retires our own dead menu result, not another extension's content.
		assert.deepEqual(
			staleMenuCalls(view),
			[],
			`${file}: another extension's compress call was read as our menu`,
		);
		// Invariant 2: the snapshot was taken before the pipeline ran, so a mutation shows up here.
		assert.equal(out, expected, `${file}: view is not Pi's byte-for-byte`);
		checked++;
		// Invariant 7: same log, same state.
		assert.equal(JSON.stringify(project(buildView(entries), [])), out, `${file}: second replay differs`);

		assertNoOrphanResults(
			view.map((item) => item.message),
			file,
		);
		for (const item of view) roleOf(item.message);
	}
	assert.equal(
		checked,
		sessionFiles().length,
		`only ${checked} recorded sessions were replayed byte-for-byte`,
	);
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
		assert.ok(
			[...ids].every((id) => id.length > 0),
			`${file}: an entry has an empty id`,
		);
		const view = buildView(entries);

		let at = 0;
		for (const entry of entries) {
			for (const message of sessionEntryToContextMessages(entry)) {
				const item = view[at] ?? assert.fail(`${file}: the view stops at ${at}`);
				assert.ok(
					ids.has(item.entryId),
					`${file}: ${item.entryId} is not an id from buildContextEntries`,
				);
				assert.equal(
					item.entryId,
					entry.id,
					`${file}: item ${at} names ${item.entryId}, not its entry`,
				);
				assert.equal(
					JSON.stringify(item.message),
					JSON.stringify(message),
					`${file}: item ${at} holds another message`,
				);
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
	assert.equal(
		userText(out[0] ?? assert.fail("no summary emitted")),
		summaryOf("b1", covered.length, folded.originalPath),
	);
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
	assert.equal(
		JSON.stringify(project(view, [cutHead])),
		JSON.stringify(out),
		"a cut span loses its summary",
	);
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
	assert.notEqual(
		at.length,
		last - start + 1,
		"the coverage is contiguous, so this fixture proves nothing",
	);

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

/**
 * The two-hop closure that re-derived round alignment inside the projection is gone: the menu
 * partitions the view by rounds, so every span the model can name is already whole. This is the
 * property that made the closure redundant, held directly on every entry of a real menu.
 */
test("every menu entry is whole rounds, so folding one never orphans a result", () => {
	const view = buildView(longSession());
	const menu = buildMenu(view, []);
	const slots = projectSlots(view, []);
	const answerOf = new Map<string, string>();
	for (const slot of slots) {
		if (slot.message.role === "toolResult" && slot.entryId !== undefined)
			answerOf.set(slot.message.toolCallId, slot.entryId);
	}

	for (const entry of menu.entries) {
		const inside = new Set(entry.entryIds);
		for (const slot of slots) {
			if (slot.entryId === undefined || !inside.has(slot.entryId)) continue;
			for (const id of toolCallIds(slot.message)) {
				// An aborted turn can leave a call unanswered; pi-ai repairs that direction, not this one.
				const answer = answerOf.get(id);
				if (answer !== undefined)
					assert.ok(inside.has(answer), `${entry.id}: call ${id} is answered outside it`);
			}
		}
	}

	const middle = menu.entries[Math.floor(menu.entries.length / 2)] ?? assert.fail("empty menu");
	const out = project(view, [block({ entryIds: middle.entryIds, msgs: middle.entryIds.length })]);
	assert.equal(
		out.length,
		view.length - middle.entryIds.length + 1,
		"a fold removed more than the entry named",
	);
	assertNoOrphanResults(out, "after folding one menu entry");
	assertNoStraddle(out, "after folding one menu entry");
});

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
	assert.equal(
		out.filter((message) => message.role === "toolResult" && message.toolCallId === dropped).length,
		0,
	);
	assert.equal(
		out.filter((message) => message.role === "toolResult" && message.toolCallId === sibling).length,
		1,
	);
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
	const first = block({ id: "b1", entryIds: ["a", "b"], dropToolCallIds: ["call-1"], msgs: 2 });
	const second = block({
		id: "b2",
		entryIds: ["c"],
		blockIds: ["b1"],
		dropToolCallIds: ["call-2"],
		msgs: 3,
	});
	const third = block({
		id: "b3",
		entryIds: ["d"],
		blockIds: ["b2"],
		dropToolCallIds: ["call-3"],
		msgs: 4,
	});
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
	// Without the retired calls, b1's own compress call comes back — and its arguments still carry
	// the whole summary b1 replaced, so condensing summaries would reclaim nothing.
	assert.deepEqual([...(live[0] ?? assert.fail("b2 is not live")).dropToolCallIds].sort(), [
		"call-1",
		"call-2",
	]);

	entries.push(customEntry("e3", "fold-block", third));
	const chained = liveBlocks({ getBranch: () => entries });
	assert.deepEqual(
		chained.map((item) => item.id),
		["b3"],
	);
	assert.deepEqual([...(chained[0] ?? assert.fail("b3 is not live")).entryIds].sort(), [
		"a",
		"b",
		"c",
		"d",
	]);
	assert.deepEqual([...(chained[0] ?? assert.fail("b3 is not live")).dropToolCallIds].sort(), [
		"call-1",
		"call-2",
		"call-3",
	]);
});

/**
 * MODEL-FACING-TEXT.md §9 and DESIGN §17 rows 19.63-19.64: the line carries only what Pi cannot know, and no
 * context number at all. Pi's own footer already shows the context, and measured at 80 columns
 * `pi-powerline-footer`'s overflow row silently dropped the longer line entirely.
 */
test("the status line is MODEL-FACING-TEXT.md §9's, and shows no context number", () => {
	const shown: string[] = [];
	const ctx = {
		ui: { setStatus: (key: string, text: string | undefined) => shown.push(`${key}|${text}`) },
	};
	const blocks: FoldBlock[] = [
		block({ id: "b1", tokensBefore: 200_000, tokensAfter: 2_000 }),
		block({ id: "b2", tokensBefore: 60_000, tokensAfter: 2_000 }),
		block({ id: "b3", tokensBefore: 30_000, tokensAfter: 2_000 }),
		block({ id: "b4", tokensBefore: 30_000, tokensAfter: 2_000 }),
	];

	setFoldStatus(ctx, blocks);
	assert.equal(shown[0], `pi-context-fold|${fenced("9")}`);
});

const NOW = "2026-09-13T00:00:00.000Z";
const SESSION_ID = "context-fold-test";

function messageEntry(entries: SessionEntry[], id: string, message: Msg): void {
	entries.push({ type: "message", id, parentId: entries.at(-1)?.id ?? null, timestamp: NOW, message });
}

/** Real messages from the corpus, so no test invents a provider, an api name or a usage record. */
function sample(role: "assistant" | "toolResult" | "user"): Msg {
	for (const item of buildView(contextEntries(sessionFiles()[0] ?? assert.fail("no sessions")))) {
		if (item.message.role === role) return item.message;
	}
	throw new Error(`the first recorded session has no ${role} message`);
}

function callMessage(id: string, args: Record<string, unknown>): Msg {
	const assistant = sample("assistant");
	if (assistant.role !== "assistant") throw new Error("unreachable");
	return { ...assistant, content: [{ type: "toolCall", id, name: "compress", arguments: args }] };
}

function resultMessage(callId: string, text: string): Msg {
	const result = sample("toolResult");
	if (result.role !== "toolResult") throw new Error("unreachable");
	return {
		...result,
		toolCallId: callId,
		toolName: "compress",
		isError: false,
		content: [{ type: "text", text }],
	};
}

interface Recorder {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	entries: SessionEntry[];
	tools: ToolDefinition[];
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	sent: string[];
}

/** Pi's seams, recorded: the four the extension uses and nothing else. */
function recorder(
	entries: SessionEntry[],
	usage: () => ContextUsage | undefined,
	cwd = TEST_PROJECT,
): Recorder {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const sent: string[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			handlers.set(name, handler),
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerMessageRenderer: () => undefined,
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				id: `custom-${entries.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: NOW,
				customType,
				data,
			});
		},
		sendMessage: (message: { content: string }) => {
			sent.push(message.content);
		},
	};
	const ctx = {
		sessionManager: {
			buildContextEntries: () => buildContextEntries(entries),
			getBranch: () => entries,
			getSessionId: () => SESSION_ID,
			getSessionFile: () => join(SESSION_DIR, `${SESSION_ID}.jsonl`),
			getCwd: () => cwd,
		},
		getContextUsage: usage,
		ui: { setStatus: () => undefined },
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		ctx: ctx as unknown as ExtensionContext,
		entries,
		tools,
		handlers,
		sent,
	};
}

/** A throwaway project whose config aims the log away from the user's own ~/.pi/context-fold.log. */
function project_(): string {
	const dir = mkdtempSync(join(tmpdir(), "context-fold-"));
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "context-fold.json"), JSON.stringify({ logFile: join(dir, "fold.log") }));
	return dir;
}

const TEST_PROJECT = project_();

/** The extension as Pi runs it: registered, then started, so every test loads its config too. */
function started(
	entries: SessionEntry[],
	usage: () => ContextUsage | undefined,
	cwd = TEST_PROJECT,
): Recorder {
	const run = recorder(entries, usage, cwd);
	contextFold(run.pi);
	(run.handlers.get("session_start") ?? assert.fail("no session_start handler"))(undefined, run.ctx);
	return run;
}

function logLines(dir = TEST_PROJECT): Record<string, unknown>[] {
	const file = join(dir, "fold.log");
	if (!readdirSync(dir).includes("fold.log")) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

async function callCompress(run: Recorder, toolCallId: string, params: unknown): Promise<string> {
	const tool = run.tools[0] ?? assert.fail("compress was not registered");
	return resultText(await tool.execute(toolCallId, params, undefined, undefined, run.ctx));
}

function contextMessages(run: Recorder): Msg[] {
	const handler = run.handlers.get("context") ?? assert.fail("no context handler");
	const result = handler({ type: "context", messages: [] }, run.ctx);
	if (typeof result !== "object" || result === null || !("messages" in result))
		throw new Error("no messages");
	return result.messages as Msg[];
}

/** A session long enough to partition, with no compaction entry to complicate the count. */
function longSession(): SessionEntry[] {
	for (const file of sessionFiles()) {
		const entries = contextEntries(file);
		const view = buildView(entries);
		if (rounds(view).length < 60) continue;
		if (view.some((item) => item.message.role === "compactionSummary")) continue;
		return entries;
	}
	throw new Error("no recorded session has 60 rounds and no compaction");
}

test("rounds partition the view, one per assistant message, and never split a call from its result", () => {
	let total = 0;
	let measured = 0;
	for (const file of sessionFiles()) {
		const view = buildView(contextEntries(file));
		if (view.length === 0) continue;
		measured++;
		const grouped = rounds(view);
		total += grouped.length;

		assert.deepEqual(grouped.flat(), view, `${file}: the rounds are not a partition of the view`);
		const assistants = view.filter((item) => item.message.role === "assistant").length;
		assert.equal(
			grouped.length,
			assistants,
			`${file}: ${grouped.length} rounds for ${assistants} assistant messages`,
		);

		const roundOf = new Map<Msg, number>();
		grouped.forEach((round, index) => {
			assert.equal(
				round.filter((item) => item.message.role === "assistant").length,
				1,
				`${file}: round ${index} does not hold exactly one assistant message`,
			);
			for (const item of round) roundOf.set(item.message, index);
		});
		const caller = new Map<string, Msg>();
		for (const item of view) {
			for (const id of toolCallIds(item.message)) caller.set(id, item.message);
		}
		for (const item of view) {
			if (item.message.role !== "toolResult") continue;
			const call = caller.get(item.message.toolCallId);
			if (call === undefined) continue;
			assert.equal(
				roundOf.get(item.message),
				roundOf.get(call),
				`${file}: a round boundary splits a call from its result`,
			);
		}
	}
	// Every session, not "most of them": a floor lets one drop out of the corpus unnoticed, which is
	// how the byte-equality assertion above came to be measuring 16 of 25.
	assert.equal(
		measured,
		sessionFiles().length,
		`only ${measured} of ${sessionFiles().length} sessions have a view`,
	);
	// 7,358 when the design was written, 7,512 now; the corpus only grows.
	assert.ok(total >= 7512, `only ${total} rounds across the corpus`);
});

test("the menu partitions the foldable view into contiguous entries, evenly by round count", () => {
	const view = buildView(longSession());
	const menu = buildMenu(view, []);
	const offered = rounds(view).slice(0, -2);

	assert.ok(menu.entries.length > 1 && menu.entries.length <= 200, `${menu.entries.length} entries`);
	assert.deepEqual(
		menu.entries.map((entry) => entry.id),
		menu.entries.map((_, index) => `e${index + 1}`),
	);
	const chunk = Math.ceil(offered.length / 200);
	for (const entry of menu.entries.slice(0, -1))
		assert.equal(entry.rounds, chunk, "an entry is not one chunk of rounds");
	assert.equal(
		menu.entries.reduce((sum, entry) => sum + entry.rounds, 0),
		offered.length,
		"the entries do not cover every foldable round",
	);
	// Contiguous, in view order, every offered entry id exactly once (§5: nothing is hidden).
	assert.deepEqual(
		menu.entries.flatMap((entry) => entry.entryIds),
		offered.flat().map((item) => item.entryId),
	);
	assert.equal(
		menu.tokens,
		menu.entries.reduce((sum, entry) => sum + entry.tokens, 0),
	);
});

test("the menu offers neither the in-flight round, the one before it, nor a compaction entry", () => {
	const view = buildView(longSession());
	const offered = new Set(buildMenu(view, []).entries.flatMap((entry) => entry.entryIds));
	const tail = rounds(view).slice(-2).flat();
	assert.ok(tail.length > 0, "no tail to exclude");
	for (const item of tail)
		assert.equal(offered.has(item.entryId), false, `H1: ${item.entryId} is in the menu`);

	const { path, hoisted } = pickCompacted();
	const compacted = buildView(buildContextEntries(path));
	const ids = new Set(buildMenu(compacted, []).entries.flatMap((entry) => entry.entryIds));
	assert.ok(
		compacted.some((item) => item.entryId === hoisted.id),
		"the fixture has no compaction entry in view",
	);
	assert.equal(ids.has(hoisted.id), false, "a compaction entry was offered");
});

test("the menu is MODEL-FACING-TEXT.md §3a and §3b, verbatim", () => {
	const menu = buildMenu(buildView(longSession()), []);
	const lines = menu.text.split("\n");
	const table = fenced("3", 1).split("\n");
	const header = table[0] ?? assert.fail("§3b has no heading");
	const columns = table[2] ?? assert.fail("§3b has no column row");

	assert.ok(TEXT.includes(INSTRUCTION), "the instruction is not MODEL-FACING-TEXT.md §3a");
	assert.ok(menu.text.startsWith(INSTRUCTION), "the menu does not open with the instruction");
	for (const pinned of [header, columns])
		assert.ok(lines.includes(pinned), `the menu does not carry ${JSON.stringify(pinned)}`);
	// §3b: the example names entries from the table above it, never a constant. A live run folded
	// `e2–e3` off a fixed example while the table was empty (§17, row 19.54).
	const [one, two] = menu.entries;
	assert.ok(one && two, "the fixture needs two entries");
	assert.equal(lines.at(-1), example(one.id, two.id));
	assert.equal(menu.text.includes("content:"), false, "the example still offers an array of spans");
	const row = lines[lines.indexOf(columns) + 1] ?? assert.fail("no entry row");
	// The id, rounds and tokens columns end where the header's do, so the table reads as a table.
	assert.match(row, /^ {2}e1 {5} +\d+ +\d+(\.\d)?[KM] {2}\S/);
	for (const at of [columns.indexOf("rounds") + 6, columns.indexOf("tokens") + 6]) {
		assert.equal(row.slice(0, at).trimEnd().length, at, `the row does not end its column at ${at}`);
		assert.equal(row[at], " ", `the row runs past column ${at}`);
	}
});

/** §3b's example, refilled: the document shows `e1` and `e2`, the menu names its own two. */
function example(from: string, to: string): string {
	const line = fenced("3", 1).split("\n").at(-1) ?? assert.fail("§3b has no example");
	return line.replace('"e1"', `"${from}"`).replace('"e2"', `"${to}"`);
}

/**
 * §3b, row 19.54's other half. The example names the first entry and the second *if there is one*.
 * A one-entry menu was observed live; with the ids fixed at `e1`/`e2` it invites a fold of `e2`,
 * which is exactly the failure that rewrote this line — the empty menu was only its first form.
 */
test("MODEL-FACING-TEXT.md §3b: a one-entry menu's example names that entry twice, never an id it lacks", () => {
	const menu = buildMenu(rounds(buildView(longSession())).slice(0, 3).flat(), []);
	const only = menu.entries[0] ?? assert.fail("no entry");
	assert.equal(menu.entries.length, 1, "the fixture is not a one-entry menu");

	const last = menu.text.split("\n").at(-1) ?? assert.fail("no example");
	assert.equal(last, example(only.id, only.id));
	const offered = new Set(menu.entries.map((entry) => entry.id));
	for (const [, named] of last.matchAll(/"(e\d+)"/g)) {
		assert.ok(
			named !== undefined && offered.has(named),
			`the example names ${named}, which is not in the table`,
		);
	}
});

/**
 * §3b's `first … last`. Every session under 200 foldable rounds partitions one round per entry —
 * all four live runs — so the two labels are the same label, and printing both reads as a span of
 * two different rounds. The 226-round fixture above has none, which is why it was never caught.
 */
test("MODEL-FACING-TEXT.md §3b: an entry holding one round prints one label, not the same label twice", () => {
	const menu = buildMenu(rounds(buildView(longSession())).slice(0, 12).flat(), []);
	const rows = menu.text.split("\n");
	assert.ok(menu.entries.length > 1, "the fixture is not a table of several entries");

	for (const entry of menu.entries) {
		assert.equal(
			entry.rounds,
			1,
			`${entry.id} holds ${entry.rounds} rounds, so the fixture proves nothing`,
		);
		assert.equal(entry.first, entry.last, `${entry.id} holds one round and names two`);
		const row =
			rows.find((line) => line.startsWith(`  ${entry.id} `)) ?? assert.fail(`${entry.id} has no row`);
		assert.ok(row.endsWith(entry.first), `${entry.id}: the row does not end with its label`);
		assert.equal(
			row.endsWith(` … ${entry.first}`),
			false,
			`${entry.id}: one round still printed "first … last"`,
		);
	}
});

test("MODEL-FACING-TEXT.md §3b-empty: nothing foldable prints no table and no example", () => {
	assert.equal(fenced("3", 2), EMPTY, "the empty menu is not MODEL-FACING-TEXT.md §3b-empty");

	// Two rounds, both held back by H1 — the shape of the first live run, where five tool calls in
	// one message left the table empty and a fixed example made the model fold ids that did not exist.
	const view = rounds(buildView(longSession())).slice(0, 2).flat();
	const menu = buildMenu(view, []);
	assert.deepEqual(menu.entries, []);
	assert.equal(menu.tokens, 0);
	assert.equal(menu.text, EMPTY);
	assert.equal(menu.text.includes("Example:"), false, "an empty menu printed an example");
	assert.equal(menu.text.includes("id     rounds"), false, "an empty menu printed a table");
});

/**
 * §3b's row labels: `tool: argument`, and the argument is the tool's primary one. "First non-empty
 * string in key order" gives a `write` row the file body it is writing — 82 rows of the recorded
 * corpus. The order of the two labels is the order of the rounds, which nothing else pins.
 */
test("a menu row is labelled by its first and last round, by primary argument", () => {
	const view = buildView(longSession());
	const slots = projectSlots(view, []);
	const offered = rounds(slots).slice(0, -2);
	const menu = buildMenu(view, []);
	const chunk = Math.ceil(offered.length / 200);

	let checked = 0;
	let fromText = 0;
	for (const [index, entry] of menu.entries.entries()) {
		const group = offered.slice(index * chunk, (index + 1) * chunk);
		for (const [label, round] of [
			[entry.first, group[0]],
			[entry.last, group.at(-1)],
		] as const) {
			const slots = round ?? assert.fail(`${entry.id}: no round`);
			assert.equal(label, labelOf(slots), `${entry.id}: label is not its own round's`);
			checked++;
			if (!slots.some((slot) => toolCallIds(slot.message).length > 0)) fromText++;
		}
	}
	assert.ok(checked > menu.entries.length, `only ${checked} labels checked`);
	// 740 of the corpus's 7,485 rounds make no tool call, and 513 of those sit at a menu entry's edge.
	assert.ok(fromText > 0, "no row is labelled from a round's text, so §3b's other rule is untested here");

	const writes = menu.entries.filter(
		(entry) => entry.first.startsWith("write: ") || entry.last.startsWith("write: "),
	);
	for (const entry of writes) {
		for (const label of [entry.first, entry.last].filter((text) => text.startsWith("write: "))) {
			assert.ok(
				label.includes("/") || label.includes("."),
				`a write row is labelled ${JSON.stringify(label)}`,
			);
		}
	}
	assert.ok(writes.length > 0, "the fixture has no write call to label");
});

/** The label rule, recomputed from the round (§3b): the tool's own primary argument; the tool's bare
 * name when it has neither, with no JSON dump and no fallback to the first string; and the round's
 * first line of text when it made no call at all. Clipped to 40 either way. */
function labelOf(round: { message: Msg }[]): string {
	const call = round
		.flatMap((slot) => (slot.message.role === "assistant" ? slot.message.content : []))
		.find((part) => part.type === "toolCall");
	if (call === undefined) return clipped(firstLineOf(round));
	const args = call.arguments;
	const key = ["path", "command"].find((name) => typeof args[name] === "string" && args[name] !== "");
	return clipped(key === undefined ? call.name : `${call.name}: ${String(args[key]).replace(/\s+/g, " ")}`);
}

function firstLineOf(round: { message: Msg }[]): string {
	for (const slot of round) {
		const line = messageText(slot.message).trim().split("\n")[0];
		if (line !== undefined && line !== "") return line;
	}
	return "";
}

function clipped(text: string): string {
	return text.length <= 40 ? text : `${text.slice(0, 39)}…`;
}

test("a live block's summary is an ordinary menu row that a later fold absorbs", () => {
	const view = buildView(longSession());
	const covered = rounds(view)[0]?.map((item) => item.entryId) ?? assert.fail("no first round");
	const folded = block({
		id: "b3",
		summary: "API exploration\nmore",
		entryIds: covered,
		msgs: covered.length,
	});

	const menu = buildMenu(view, [folded]);
	const row =
		menu.entries.find((entry) => entry.blockIds.includes("b3")) ?? assert.fail("b3 is not a menu row");
	assert.ok(
		row.first.startsWith('summary b3 "API exploration') ||
			row.last.startsWith('summary b3 "API exploration'),
		row.first,
	);
	assert.equal(
		menu.entries.flatMap((entry) => entry.entryIds).some((id) => covered.includes(id)),
		false,
		"folded entries are still offered",
	);
});

test("the menu pair leaves the view a round after it is served; a failed fold stays", () => {
	const menuCall = callMessage("menu-1", {});
	const failed = callMessage("fold-1", { from: "e1", to: "e2", summary: "s" });
	const view: ViewItem[] = [
		{ entryId: "a", message: menuCall },
		{ entryId: "b", message: resultMessage("menu-1", "the menu") },
	];
	assert.deepEqual(staleMenuCalls(view), [], "the menu was dropped in the round it was served");

	view.push({ entryId: "c", message: failed });
	view.push({ entryId: "d", message: resultMessage("fold-1", '"e9" is not in the current list.') });
	assert.deepEqual(staleMenuCalls(view), ["menu-1"], "the menu did not go stale");

	// One more round, so a rule that called every compress call a menu would be caught: without it
	// the walk ends on the failed call and never has the chance to report it as stale.
	view.push({ entryId: "e", message: callMessage("menu-2", {}) });
	view.push({ entryId: "f", message: resultMessage("menu-2", "the second menu") });
	assert.deepEqual(staleMenuCalls(view), ["menu-1"], "a failed fold or a fresh menu was treated as stale");

	const out = project(view, []);
	assert.equal(out.length, 4, "only the first menu call and its result should be gone");
	assert.deepEqual(
		out,
		[failed, view[3]?.message, view[4]?.message, view[5]?.message],
		"the failed call and its result must stay untouched",
	);
});

/** MODEL-FACING-TEXT.md §1 — in every request, so it is the one block whose wording is paid on every turn. */
test("MODEL-FACING-TEXT.md §1: the system prompt block is the document's, pointed at this session's folder", () => {
	const run = started([...longSession()], () => undefined);
	const handler = run.handlers.get("before_agent_start") ?? assert.fail("no before_agent_start handler");
	const result = handler({ type: "before_agent_start", systemPrompt: "PI OWNS THIS" }, run.ctx) as {
		systemPrompt: string;
	};

	assert.equal(result.systemPrompt, `PI OWNS THIS\n\n${quoted("1").replace("<session>", SESSION_ID)}`);
});

/** MODEL-FACING-TEXT.md §2 — the description and the three parameter descriptions, also in every request. */
test("MODEL-FACING-TEXT.md §2: the tool description and its parameters are the document's", () => {
	const run = started([...longSession()], () => undefined);
	const tool = run.tools[0] ?? assert.fail("compress was not registered");
	assert.equal(run.tools.length, 1, "§6: one tool, and there is no `recall`");
	assert.equal(tool.name, "compress");
	assert.equal(tool.description, flat(quoted("2")));

	const schema = tool.parameters as unknown as { properties: Record<string, { description?: string }> };
	const bullets = section("2").split("\n");
	for (const name of ["from", "to", "summary"]) {
		const head = `- \`${name}\` — `;
		const bullet =
			bullets.find((line) => line.startsWith(head)) ?? assert.fail(`§2 has no \`${name}\` bullet`);
		assert.equal(schema.properties[name]?.description, bullet.slice(head.length).replace(/`/g, ""));
	}
});

/** MODEL-FACING-TEXT.md §4 and §6, built with the document's own example values so they compare whole. */
test("MODEL-FACING-TEXT.md §4 and §6: the success result and the summary wrapper are the document's", () => {
	const record = block({ id: "b5", msgs: 38, originalPath: "~/.pi/agent/context-fold/01a094/b5.txt" });
	assert.equal(resultLine(record, "e1", "e37"), flat(quoted("4")).replace(/`/g, ""));

	const message = summaryMessage({ ...record, summary: "…the model's summary text…" });
	// §6: the role is load-bearing. pi-ai reads a `user` message as interrupting a tool flow, which
	// is what turns a mis-placed summary into a provider rejection rather than a silent oddity.
	assert.equal(message.role, "user");
	assert.equal(userText(message), fenced("6"));
});

test("compress() serves the menu, folds a span, and the fold leaves nothing straddling", async () => {
	const entries = [...longSession()];
	const run = started(entries, () => undefined);

	messageEntry(entries, "menu-call", callMessage("menu-1", {}));
	const menu = await callCompress(run, "menu-1", {});
	messageEntry(entries, "menu-result", resultMessage("menu-1", menu));
	assert.ok(menu.includes("  e1     "), "no entry table");

	const before = buildMenu(buildView(buildContextEntries(entries)), []).entries.slice(0, 2);
	messageEntry(
		entries,
		"fold-call",
		callMessage("fold-1", { from: "e1", to: "e2", summary: "what happened" }),
	);
	const folded = await callCompress(run, "fold-1", { from: "e1", to: "e2", summary: "what happened" });
	messageEntry(entries, "fold-result", resultMessage("fold-1", folded));

	const record = liveBlocks({ getBranch: () => entries })[0] ?? assert.fail("no block was recorded");
	assert.equal(
		folded,
		`Folded e1–e2 into b1. ${shortTokens(record.tokensBefore)} → ${shortTokens(record.tokensAfter)}, ` +
			`${record.msgs} messages replaced. Original: ${join(agentDir(), "context-fold", SESSION_ID, "b1.txt")}`,
	);
	assert.deepEqual(
		record.entryIds,
		before.flatMap((entry) => entry.entryIds),
	);
	assert.deepEqual(record.dropToolCallIds, ["fold-1"]);

	const out = contextMessages(run);
	const summary = out.filter(
		(message) => message.role === "user" && userText(message).startsWith('<summary block="b1"'),
	);
	assert.equal(summary.length, 1, "one summary, at the block's first covered entry");
	assert.equal(
		out.filter(
			(message) => toolCallIds(message).includes("fold-1") || toolCallIds(message).includes("menu-1"),
		).length,
		0,
		"the compress pairs are still in the view",
	);
	assert.equal(
		out.filter((message) => message.role === "toolResult" && message.toolCallId === "menu-1").length,
		0,
	);
	// 6,654 of the corpus's 7,443 assistant messages carry no text, so the message that made the
	// compress call holds only that call: retiring it leaves nothing, and nothing is not a message.
	assert.equal(
		out.filter((message) => message.role === "assistant" && message.content.length === 0).length,
		0,
		"an emptied assistant message survived its retired call",
	);
	assertNoOrphanResults(out, "after a live fold");
	assertNoStraddle(out, "after a live fold");

	// The record counts what the projection removed, not the span the model named (§16).
	const view = buildView(buildContextEntries(entries));
	assert.equal(out.length, view.length - record.msgs - 4 + 1, "msgs does not match what left the view");
	assert.equal(
		readFileSync(join(homedir(), ".cache/pi/context-fold", SESSION_ID, "b1.txt"), "utf8").length > 0,
		true,
	);
});

/**
 * §12 invariant 5: the file must match the entries the block covered. A "contains the first line"
 * check cannot see three mutations this one kills — sections in the wrong order, section numbers
 * that do not count the sections, and an assistant section that drops its tool-call arguments.
 */
test("a fold's file is the messages it replaced, in order, numbered, arguments and all", async () => {
	const entries = [...longSession()];
	const run = started(entries, () => undefined);
	messageEntry(entries, "menu-call", callMessage("menu-1", {}));
	await callCompress(run, "menu-1", {});
	await callCompress(run, "fold-1", { from: "e1", to: "e1", summary: "s" });

	const record = liveBlocks({ getBranch: () => entries })[0] ?? assert.fail("no block");
	const file = readFileSync(
		join(homedir(), ".cache/pi/context-fold", SESSION_ID, `${record.id}.txt`),
		"utf8",
	);
	const covered = new Set(record.entryIds);
	const replaced = buildView(buildContextEntries(entries))
		.filter((item) => covered.has(item.entryId))
		.map((item) => item.message);

	assert.ok(replaced.length > 1, "the fixture covers too little to order");
	assert.equal(replaced.length, record.msgs, "`msgs` counts something other than what was replaced");
	assert.equal(file, replaced.map(sectionOf).join("\n\n"), "the file is not the messages it replaced");
	assert.ok(
		replaced.some(
			(message) =>
				message.role === "assistant" && message.content.some((part) => part.type === "toolCall"),
		),
		"the fixture has no tool call, so dropped arguments would not show",
	);
});

/** dump.ts's format, written out again so the file has something to be equal to. */
function sectionOf(message: Msg, index: number): string {
	const label =
		message.role === "toolResult"
			? ` ${message.toolName}${message.isError ? " (error)" : ""}`
			: message.role === "custom"
				? ` ${message.customType}`
				: "";
	const body =
		message.role === "assistant"
			? message.content
					.map((part) => {
						if (part.type === "text") return part.text;
						if (part.type === "thinking") return `[thinking] ${part.thinking}`;
						return `[toolCall ${part.name} ${part.id}] ${JSON.stringify(part.arguments)}`;
					})
					.join("\n")
			: messageText(message);
	return `=== ${index + 1} ${message.role}${label} ===\n${body}`;
}

/** MODEL-FACING-TEXT.md §5, read from the document: each failure names the id and the next action (P3). The
 * ids are the document's own, so the messages compare whole rather than by shape. */
test("compress rejections are MODEL-FACING-TEXT.md §5's, and change nothing", async () => {
	const entries = [...longSession()];
	const run = started(entries, () => undefined);
	const unknown = failure("Unknown id");
	// Before any menu there is no list at all, and the answer is still an error, never the menu (§5).
	await assert.rejects(() => callCompress(run, "fold-x", { from: "e412", to: "e413", summary: "s" }), {
		message: unknown,
	});

	await callCompress(run, "menu-1", {});
	const menu = buildMenu(buildView(buildContextEntries(entries)), []);
	assert.ok(
		menu.entries.length >= 40,
		`the fixture needs e40, and the menu has ${menu.entries.length} entries`,
	);
	await assert.rejects(() => callCompress(run, "fold-x", { from: "e1", to: "e412", summary: "s" }), {
		message: unknown,
	});
	// Fix 1 also answers this one — a reversed span covers nothing — but §5 keeps the sharper message.
	await assert.rejects(() => callCompress(run, "fold-x", { from: "e40", to: "e3", summary: "s" }), {
		message: failure("`to` before `from`"),
	});
	await assert.rejects(() => callCompress(run, "fold-x", { from: "e1", to: "e1", summary: " " }), {
		message: failure("Empty summary"),
	});
	// Part of a span is a failed call, not a menu request: answering a malformed call with the menu
	// costs ~5K and hides the failure (§5, §6). The id it names is "undefined", which is truthful.
	await assert.rejects(() => callCompress(run, "fold-x", { summary: "s" }));
	assert.equal(liveBlocks({ getBranch: () => entries }).length, 0, "a rejected call wrote a record");

	// A fold reissues the ids, so the menu it was validated against is gone.
	await callCompress(run, "fold-1", { from: "e1", to: "e1", summary: "s" });
	await assert.rejects(() => callCompress(run, "fold-2", { from: "e1", to: "e1", summary: "s" }), {
		message: unknown.replace("e412", "e1"),
	});
});

/**
 * C7. The menu outlives the turn that issued it, and a compaction between the two calls cuts the
 * entries it named out of the view. Reproduced live: a menu over a 468-message view, a compaction
 * down to 48, and the fold then answered "0.0K → 0.0K, 0 messages replaced", wrote a `fold-block`
 * with `msgs: 0` and a zero-byte original, and the model's summary never entered the view. The
 * refusal is on the plan, not on the menu, so every way of naming an empty span lands here.
 */
test("a fold whose span a compaction has emptied is refused, and writes nothing", async () => {
	const entries = [...longSession()];
	const run = started(entries, () => undefined);
	await callCompress(run, "menu-1", {});
	const before = buildView(buildContextEntries(entries)).length;

	const leaf = entries.at(-1) ?? assert.fail("no entries");
	const keep = entries.at(-3) ?? assert.fail("no entries");
	entries.push(compactionEntry("cut", leaf.id, keep.id));
	const after = buildView(buildContextEntries(entries)).length;
	assert.ok(after * 10 < before, `the compaction cut ${before} messages to ${after}, which proves nothing`);

	await assert.rejects(
		() => callCompress(run, "fold-1", { from: "e1", to: "e3", summary: "what happened" }),
		{
			message:
				"Folding e1–e3 would replace nothing: the list is out of date. Call compress() for the current one.",
		},
	);
	assert.deepEqual(liveBlocks({ getBranch: () => entries }), [], "the refused fold wrote a record");
});

test("condensing an earlier summary absorbs the block, counts it, and keeps its retired calls out", async () => {
	const entries = [...longSession()];
	const run = started(entries, () => undefined);

	messageEntry(entries, "menu-1-call", callMessage("menu-1", {}));
	await callCompress(run, "menu-1", {});
	messageEntry(entries, "menu-1-result", resultMessage("menu-1", "the first menu"));
	const first = { from: "e1", to: "e1", summary: "first" };
	messageEntry(entries, "fold-1-call", callMessage("fold-1", first));
	await callCompress(run, "fold-1", first);
	messageEntry(entries, "fold-1-result", resultMessage("fold-1", "Folded e1–e1 into **b1**."));

	messageEntry(entries, "menu-2-call", callMessage("menu-2", {}));
	const text = await callCompress(run, "menu-2", {});
	messageEntry(entries, "menu-2-result", resultMessage("menu-2", text));
	const live = liveBlocks({ getBranch: () => entries });
	const menu = buildMenu(buildView(buildContextEntries(entries)), live);
	const row =
		menu.entries.find((entry) => entry.blockIds.includes("b1")) ?? assert.fail("b1 is not a menu row");
	const next = menu.entries[menu.entries.indexOf(row) + 1] ?? assert.fail("no row after b1");

	const second = { from: row.id, to: next.id, summary: "second" };
	messageEntry(entries, "fold-2-call", callMessage("fold-2", second));
	await callCompress(run, "fold-2", second);
	const blocks = liveBlocks({ getBranch: () => entries });
	assert.deepEqual(
		blocks.map((entry) => entry.id),
		["b2"],
		"b1 is still live after being absorbed",
	);
	const b2 = blocks[0] ?? assert.fail("no b2");
	assert.deepEqual(b2.blockIds, ["b1"]);
	// §16: `msgs` counts what the projection removed, and the absorbed summary is one of them.
	assert.equal(
		b2.msgs,
		row.entryIds.length + next.entryIds.length + 1,
		"the absorbed summary was not counted",
	);
	assert.deepEqual([...b2.dropToolCallIds].sort(), ["fold-1", "fold-2"]);

	const out = contextMessages(run);
	assert.equal(
		out.filter((message) => message.role === "user" && userText(message).startsWith("<summary")).length,
		1,
		"the absorbed block still emits its own summary",
	);
	assert.equal(
		out.filter((message) =>
			toolCallIds(message).some((id) => id.startsWith("fold-") || id.startsWith("menu-")),
		).length,
		0,
		"an absorbed block's compress call is back in the view, and its arguments hold the old summary",
	);
	assertNoOrphanResults(out, "after condensing a summary");
	assertNoStraddle(out, "after condensing a summary");
});

test("a block whose entries have all left the view emits no summary and does not throw", () => {
	const view = buildView(longSession());
	const gone = block({ id: "b9", entryIds: ["cut-1", "cut-2"], msgs: 2 });
	const out = project(view, [gone]);
	assert.deepEqual(
		out,
		view.map((item) => item.message),
		"a block with nothing left in the view changed the projection",
	);
});

function usageOf(tokens: number | null): ContextUsage {
	return {
		tokens,
		contextWindow: 1_000_000,
		percent: tokens === null ? null : Math.round(tokens / 10_000),
	};
}

test("the nudge is growth from zero, re-anchors only downwards, and skips the round after a fold", async () => {
	const entries = [...longSession()];
	let usage: ContextUsage | undefined = usageOf(199_999);
	const run = started(entries, () => usage);
	const turnEnd = run.handlers.get("turn_end") ?? assert.fail("no turn_end handler");

	turnEnd(undefined, run.ctx);
	assert.deepEqual(run.sent, [], "a nudge fired below the step");

	usage = usageOf(200_000);
	turnEnd(undefined, run.ctx);
	assert.equal(run.sent.length, 1, "no nudge at the step");
	// MODEL-FACING-TEXT.md §7 whole, with this run's four numbers in place of the document's.
	assert.equal(run.sent[0], nudgeOf(entries, "200K of 1.0M", "+200K"));

	usage = usageOf(399_999);
	turnEnd(undefined, run.ctx);
	assert.equal(run.sent.length, 1, "the baseline did not re-anchor on the nudge");

	// Pi reports no number right after a compaction, and none at all without a model.
	usage = usageOf(null);
	turnEnd(undefined, run.ctx);
	usage = undefined;
	turnEnd(undefined, run.ctx);
	assert.equal(run.sent.length, 1, "a nudge fired on a number Pi does not have");

	// A fall re-anchors: the next nudge is 200K above the new floor, not the old one.
	usage = usageOf(150_000);
	turnEnd(undefined, run.ctx);
	usage = usageOf(349_999);
	turnEnd(undefined, run.ctx);
	assert.equal(run.sent.length, 1, "the baseline did not follow the number down");

	await callCompress(run, "menu-1", {});
	await callCompress(run, "fold-1", { from: "e1", to: "e1", summary: "s" });
	usage = usageOf(350_000);
	turnEnd(undefined, run.ctx);
	assert.equal(run.sent.length, 1, "a nudge fired in the round straight after a fold");
	turnEnd(undefined, run.ctx);
	assert.equal(run.sent.length, 2, "the pause after a fold lasted more than one round");
});

/**
 * §17 row 19.56. Anchoring the baseline on the current context put a resumed 800K session out of
 * reach: the nudge then needed 1.0M of a 1.0M window and could never fire. There is no
 * `session_start` baseline any more, so the first turn of a resumed session is nudged.
 */
test("a resumed session is nudged on its first turn", () => {
	const entries = [...longSession()];
	const run = started(entries, () => usageOf(800_000));
	(run.handlers.get("turn_end") ?? assert.fail("no turn_end handler"))(undefined, run.ctx);
	assert.equal(run.sent.length, 1, "the first turn of a resumed 800K session was not nudged");
	assert.equal(run.sent[0], nudgeOf(entries, "800K of 1.0M", "+800K"));
});

/** MODEL-FACING-TEXT.md §7, refilled: the document shows `640K of 1.0M`, `+200K` and a foldable total. */
function nudgeOf(entries: SessionEntry[], used: string, growth: string): string {
	const menu = buildMenu(buildView(buildContextEntries(entries)), liveBlocks({ getBranch: () => entries }));
	return fenced("7")
		.replace("640K of 1.0M", used)
		.replace("+200K since", `${growth} since`)
		.replace(
			"~420K foldable in 199 entries",
			`~${shortTokens(menu.tokens)} foldable in ${menu.entries.length} entries`,
		);
}

test("config: a missing file uses the defaults; an unknown key, a wrong type and bad JSON throw", () => {
	// The values, not the object: `deepEqual(…, DEFAULTS)` also passes for a loader that returns
	// DEFAULTS itself, which hands out the shared object and reads no file at all.
	const defaults = loadConfig(emptyProject());
	assert.equal(defaults.nudgeGrowthTokens, 200_000);
	assert.equal(defaults.logFile, join(REAL_HOME, ".pi", "agent", "context-fold.log"));
	assert.equal(defaults.debug, false);
	assert.throws(() => loadConfig(withConfig({ nudgeGrowthTokns: 50_000 })), {
		message:
			/^.*context-fold\.json: unknown key "nudgeGrowthTokns"\. The keys are nudgeGrowthTokens, logFile, debug\.$/,
	});
	assert.throws(() => loadConfig(withConfig({ debug: "yes" })), {
		message: /^.*context-fold\.json: "debug" is "yes", which that key does not take\.$/,
	});
	const broken = emptyProject();
	mkdirSync(join(broken, ".pi"));
	writeFileSync(join(broken, ".pi", "context-fold.json"), "{oops");
	assert.throws(() => loadConfig(broken), { message: /context-fold\.json is not valid JSON: / });

	// `null` is the documented way to ask for the default log file (§13).
	assert.equal(
		loadConfig(withConfig({ logFile: null })).logFile,
		join(REAL_HOME, ".pi", "agent", "context-fold.log"),
	);
	assert.equal(loadConfig(withConfig({ nudgeGrowthTokens: 50_000 })).nudgeGrowthTokens, 50_000);
	assert.equal(
		loadConfig(emptyProject()).nudgeGrowthTokens,
		200_000,
		"one project's file became the next one's default",
	);
});

/** Decision 17: the project file wins. Swapping the two reads passes every other test in this file,
 * because none of them writes a home config — and writing one means moving HOME, never the user's. */
test("config: the project file overrides the home file, key by key", () => {
	mkdirSync(agentDir(), { recursive: true });
	writeFileSync(
		join(agentDir(), "context-fold.json"),
		JSON.stringify({ nudgeGrowthTokens: 111_000, debug: true }),
	);
	try {
		assert.equal(loadConfig(emptyProject()).nudgeGrowthTokens, 111_000, "the home file was not read");
		const both = loadConfig(withConfig({ nudgeGrowthTokens: 222_000 }));
		assert.equal(both.nudgeGrowthTokens, 222_000, "the home file overrode the project's");
		assert.equal(both.debug, true, "a key only the home file sets was dropped");
	} finally {
		rmSync(join(agentDir(), "context-fold.json"));
	}
});

/** §13: every key has a test that proves its non-default value changes behaviour (#210, #275). */
test("config: each key's non-default value changes what the extension does", async () => {
	const dir = withConfig({
		nudgeGrowthTokens: 50_000,
		logFile: join(emptyProject(), "elsewhere.log"),
		debug: true,
	});
	const config = loadConfig(dir);
	const entries = [...longSession()];
	const run = started(entries, () => usageOf(60_000), dir);
	const turnEnd = run.handlers.get("turn_end") ?? assert.fail("no turn_end handler");

	turnEnd(undefined, run.ctx);
	assert.equal(run.sent.length, 1, "nudgeGrowthTokens = 50,000 did not nudge at 60K");

	const written = readFileSync(config.logFile, "utf8");
	assert.match(written, /"event":"nudge"/, "logFile did not take the records");
	assert.equal(
		logLines().some((line) => line.predicted === 60_000),
		false,
		"the records went to the default file as well",
	);

	// debug adds the per-round record that the default drops.
	turnEnd(undefined, run.ctx);
	assert.match(
		readFileSync(config.logFile, "utf8"),
		/"event":"quiet"/,
		"debug = true logged no quiet round",
	);
	const quiet = started([...longSession()], () => usageOf(60_000));
	(quiet.handlers.get("turn_end") ?? assert.fail("no turn_end handler"))(undefined, quiet.ctx);
	assert.equal(
		logLines().some((line) => line.event === "quiet"),
		false,
		"debug = false still logged a quiet round",
	);
});

test("the log records a fold, a nudge, and a block it can no longer use", async () => {
	const dir = withConfig({ logFile: join(emptyProject(), "fold.log") });
	const file = loadConfig(dir).logFile;
	const entries = [...longSession()];
	const run = started(entries, () => usageOf(400_000), dir);

	await callCompress(run, "menu-1", {});
	await callCompress(run, "fold-1", { from: "e1", to: "e1", summary: "s" });
	(run.handlers.get("turn_end") ?? assert.fail("no turn_end handler"))(undefined, run.ctx);

	const records = readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const fold = records.find((line) => line.event === "fold") ?? assert.fail("no fold record");
	assert.equal(fold.block, "b1");
	assert.equal(typeof fold.tokensBefore, "number");
	assert.equal(typeof fold.at, "string");
	// §10's one measurement, with no decision attached: a summary that did not shrink anything.
	assert.equal((fold.tokensAfter as number) < (fold.tokensBefore as number), true);

	// Decision 28, noticed at `turn_end` because the projection is pure (D2): a block whose entries
	// have all left the view is skipped by the projection and reported here, once.
	run.pi.appendEntry("fold-block", block({ id: "b9", entryIds: ["cut-1"] }));
	const turnEnd = run.handlers.get("turn_end") ?? assert.fail("no turn_end handler");
	turnEnd(undefined, run.ctx);
	turnEnd(undefined, run.ctx);
	const orphans = readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.includes('"block-without-summary"'));
	assert.equal(orphans.length, 1, `reported ${orphans.length} times, not once`);
	assert.match(orphans[0] ?? "", /"block":"b9"/);

	// And it does not wedge folding: only a block that still has a summary has one to lose.
	await callCompress(run, "menu-2", {});
	await callCompress(run, "fold-2", { from: "e1", to: "e1", summary: "s" });
});

function emptyProject(): string {
	return mkdtempSync(join(tmpdir(), "context-fold-"));
}

function withConfig(keys: Record<string, unknown>): string {
	const dir = emptyProject();
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "context-fold.json"), JSON.stringify(keys));
	return dir;
}

interface CompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

function compactEvent(
	entries: SessionEntry[],
	reason: "manual" | "threshold" | "overflow",
): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: entries[0]?.id ?? assert.fail("no entries"),
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 987_654,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		branchEntries: entries,
		reason,
		willRetry: reason === "overflow",
		signal: new AbortController().signal,
	};
}

function compact(run: Recorder, event: SessionBeforeCompactEvent): CompactResult {
	const handler =
		run.handlers.get("session_before_compact") ?? assert.fail("no session_before_compact handler");
	return (handler(event, run.ctx) ?? {}) as CompactResult;
}

/** The values of §8's note that only the run knows. */
const DUMPED: [string, string][] = [
	["1,830 messages", "[\\d,]+ messages"],
	["~412K tokens", "~\\d+(\\.\\d)?[KM] tokens"],
	[
		"~/.cache/pi/context-fold/overflow/01a094-1789192.txt",
		"~/\\.cache/pi/context-fold/overflow/\\S+\\.txt",
	],
	["<sessionFile>", "\\S+"],
];

/** §8's note without its last sentence, which is printed only when the cut fully orphans a block. */
function head(text: string): string {
	return text.slice(0, text.indexOf(" Summaries you wrote"));
}

function tail(text: string): string {
	return text.slice(text.indexOf("Summaries you wrote"));
}

function overflowFile(summary: string): string {
	const relative = /~\/(\S+\.txt)/.exec(summary)?.[1] ?? assert.fail("the note names no file");
	return join(homedir(), relative);
}

test("emergency: threshold is cancelled, overflow and manual are answered with our own cut", () => {
	const entries = [...longSession()];
	const run = started(entries, () => undefined);
	assert.deepEqual(
		compact(run, compactEvent(entries, "threshold")),
		{ cancel: true },
		"threshold was not cancelled",
	);

	for (const reason of ["overflow", "manual"] as const) {
		const result = compact(run, compactEvent(entries, reason));
		assert.equal(result.cancel, undefined, `${reason} was cancelled`);
		const compaction = result.compaction ?? assert.fail(`${reason} supplied no compaction`);
		// Pi's own number, never one of ours (C5).
		assert.equal(compaction.tokensBefore, 987_654);
		assert.ok(
			entries.some((entry) => entry.id === compaction.firstKeptEntryId),
			"the cut point is not on the branch",
		);
	}
});

test("emergency: the cut keeps the newer half whole and writes the older half verbatim", () => {
	const entries = [...longSession()];
	const run = started(entries, () => undefined);
	const view = buildView(buildContextEntries(entries));
	const slots = projectSlots(view, []);
	const weigh = (messages: Msg[]) => messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	const total = weigh(slots.map((slot) => slot.message));

	const compaction =
		compact(run, compactEvent(entries, "overflow")).compaction ?? assert.fail("no compaction");
	const at = view.findIndex((item) => item.entryId === compaction.firstKeptEntryId);
	assert.ok(at > 0, "the cut kept the whole view");
	const kept = new Set(view.slice(at).map((item) => item.entryId));
	const keptMessages = slots.flatMap((slot) =>
		slot.entryId !== undefined && kept.has(slot.entryId) ? [slot.message] : [],
	);
	const cut = slots.flatMap((slot) =>
		slot.entryId === undefined || !kept.has(slot.entryId) ? [slot.message] : [],
	);

	assert.ok(weigh(cut) * 2 >= total, `freed only ${weigh(cut)} of ${total} tokens`);
	assert.ok(keptMessages.length > 0, "the cut kept nothing");
	// H2: the kept side never opens with a result whose call was cut away.
	assertNoOrphanResults(keptMessages, "after the overflow cut");
	assert.equal(readFileSync(overflowFile(compaction.summary), "utf8"), cut.map(sectionOf).join("\n\n"));
	// MODEL-FACING-TEXT.md §8's note, less the sentence that only a fully cut block earns. Two values stay
	// patterns because only the run knows them: the dump's timestamp, and the token total.
	assert.match(compaction.summary, asPattern(head(note(0)), DUMPED));
});

/**
 * §17 row 19.10. Pi does not check `firstKeptEntryId`: an id that is not on the branch makes
 * `buildContextEntries` discard the entire pre-compaction history and report success. We no longer
 * check it either, because it cannot happen: `buildContextEntries` returns a subset of the branch it
 * was built from — reordered, never invented — and our cut point is one of those entries. That is
 * held below on all 25 recorded sessions. A check that cannot fire would be a throw inside a handler
 * §8 requires never to throw, and a throw there hands the turn to Pi's raw summariser (D5).
 */
test("emergency: our cut point is on the branch by construction, so it never wipes the history", () => {
	for (const file of sessionFiles()) {
		const entries = contextEntries(file);
		const ids = new Set(entries.map((entry) => entry.id));
		for (const entry of buildContextEntries(entries)) {
			assert.ok(
				ids.has(entry.id),
				`${file}: buildContextEntries returned ${entry.id}, which is not on the branch`,
			);
		}
	}

	const entries = [...longSession()];
	const leaf = entries.at(-1) ?? assert.fail("no entries");
	const wiped = buildContextEntries([...entries, compactionEntry("bad", leaf.id, "not-an-entry-id")]);
	assert.deepEqual(
		wiped.map((entry) => entry.id),
		["bad"],
		"Pi kept history after a cut point that names nothing",
	);

	const run = started(entries, () => undefined);
	const compaction =
		compact(run, compactEvent(entries, "overflow")).compaction ?? assert.fail("no compaction");
	const good = buildContextEntries([
		...entries,
		compactionEntry("ours", leaf.id, compaction.firstKeptEntryId),
	]);
	assert.ok(good.length > 1, "our own cut point wiped the history");
	assert.ok(
		entries.some((entry) => entry.id === compaction.firstKeptEntryId),
		"the cut point is not on the branch",
	);
});

/**
 * §8 and §17 row 19.65. A one-round view has no boundary to cut at. The handler used to throw, the
 * runner swallowed it, and Pi then summarised the raw history — the D5 overflow this project exists
 * to prevent. It now keeps everything and lets Pi report the failure in its own words.
 */
test("emergency: a one-round view cuts nothing and still answers, rather than throwing", () => {
	const entries: SessionEntry[] = [];
	messageEntry(entries, "only-u", sample("user"));
	messageEntry(entries, "only-a", assistantCalling("only-1"));
	messageEntry(entries, "only-r", resultMessage("only-1", "E".repeat(200_000)));

	const run = started(entries, () => undefined);
	const view = buildView(buildContextEntries(entries));
	assert.equal(rounds(view).length, 1, "the fixture is not one round");

	const result = compact(run, compactEvent(entries, "overflow"));
	assert.equal(result.cancel, undefined, "the emergency path cancelled");
	const compaction = result.compaction ?? assert.fail("no compaction");
	assert.equal(compaction.firstKeptEntryId, "only-u", "the compaction did not keep the whole view");
	assert.ok(
		entries.some((entry) => entry.id === compaction.firstKeptEntryId),
		"the cut point is not on the branch",
	);
});

test("emergency: a block the cut orphans has its own summary carried into the note", async () => {
	const entries = [...longSession()];
	const run = started(entries, () => undefined);
	await callCompress(run, "menu-1", {});
	await callCompress(run, "fold-1", { from: "e1", to: "e1", summary: "what the first phase settled" });
	const record = liveBlocks({ getBranch: () => entries })[0] ?? assert.fail("no block");

	const compaction =
		compact(run, compactEvent(entries, "overflow")).compaction ?? assert.fail("no compaction");
	const kept = new Set(
		buildView(buildContextEntries(entries))
			.slice(
				buildView(buildContextEntries(entries)).findIndex(
					(item) => item.entryId === compaction.firstKeptEntryId,
				),
			)
			.map((item) => item.entryId),
	);
	assert.equal(
		record.entryIds.some((id) => kept.has(id)),
		false,
		"the cut did not orphan the block, so this proves nothing",
	);
	assert.ok(
		compaction.summary.includes(tail(note(0))),
		"the note does not carry §8's sentence about reproduced summaries",
	);
	assert.ok(
		compaction.summary.includes(messageText(summaryMessage(record))),
		"the orphaned block's own summary is not reproduced in the note, verbatim",
	);
});

/**
 * H2 at the cut. The 50% mark falls between the two results of one round here, so a cut taken at
 * the mark keeps a tool result whose call it removed — the one direction pi-ai does not repair. Only
 * whole rounds are cut, and this is the fixture that tells the two apart.
 */
test("emergency: a cut whose mark falls inside a round takes the whole round", () => {
	const entries: SessionEntry[] = [];
	messageEntry(entries, "u0", sample("user"));
	messageEntry(entries, "a0", assistantCalling("warm-1"));
	messageEntry(entries, "r0", resultMessage("warm-1", "warm"));
	messageEntry(entries, "u1", sample("user"));
	messageEntry(entries, "a1", assistantCalling("big-1", "big-2"));
	messageEntry(entries, "r1", resultMessage("big-1", "A".repeat(40_000)));
	messageEntry(entries, "r2", resultMessage("big-2", "B".repeat(40_000)));
	messageEntry(entries, "u2", sample("user"));
	messageEntry(entries, "a2", assistantCalling("tail-1"));
	messageEntry(entries, "r3", resultMessage("tail-1", "done"));

	const run = started(entries, () => undefined);
	const compaction =
		compact(run, compactEvent(entries, "overflow")).compaction ?? assert.fail("no compaction");
	const view = buildView(buildContextEntries(entries));
	const at = view.findIndex((item) => item.entryId === compaction.firstKeptEntryId);
	assert.ok(at > 0, "the cut kept the whole view");
	const kept = projectSlots(view.slice(at), []).map((slot) => slot.message);
	assertNoOrphanResults(kept, "after a cut whose mark fell inside a round");
	assert.equal(compaction.firstKeptEntryId, "u2", "the cut is not at a round boundary");
});

function assistantCalling(...ids: string[]): Msg {
	const assistant = sample("assistant");
	if (assistant.role !== "assistant") throw new Error("unreachable");
	return {
		...assistant,
		content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: { command: id } })),
	};
}

/**
 * The cut point is the entry after the last one being cut, not the first kept message's entry. The
 * entries between them are already folded away, so keeping them costs nothing in tokens and saves
 * every block whose last covered entry lies in that run — this is as far as §8's "walk back until
 * the cut orphans no live block" can go without giving up the half it has to free.
 */
test("emergency: covered entries before the cut are kept, because keeping them is free", () => {
	const entries: SessionEntry[] = [];
	messageEntry(entries, "uA", sample("user"));
	messageEntry(entries, "aA", assistantCalling("a-1"));
	messageEntry(entries, "rA", resultMessage("a-1", "C".repeat(40_000)));
	messageEntry(entries, "uB", sample("user"));
	messageEntry(entries, "aB", assistantCalling("b-1"));
	messageEntry(entries, "rB", resultMessage("b-1", "D".repeat(40_000)));
	messageEntry(entries, "uC", sample("user"));
	messageEntry(entries, "aC", assistantCalling("c-1"));
	messageEntry(entries, "rC", resultMessage("c-1", "small"));
	messageEntry(entries, "uD", sample("user"));
	messageEntry(entries, "aD", assistantCalling("d-1"));
	messageEntry(entries, "rD", resultMessage("d-1", "small"));

	const run = started(entries, () => undefined);
	run.pi.appendEntry("fold-block", block({ id: "b1", entryIds: ["uB", "aB", "rB"], msgs: 3 }));
	const compaction =
		compact(run, compactEvent(entries, "overflow")).compaction ?? assert.fail("no compaction");

	assert.equal(compaction.firstKeptEntryId, "uB", "the cut threw away folded entries it could have kept");
	const kept = new Set(
		buildView(buildContextEntries(entries))
			.slice(buildView(buildContextEntries(entries)).findIndex((item) => item.entryId === "uB"))
			.map((item) => item.entryId),
	);
	assert.ok(
		["uB", "aB", "rB"].some((id) => kept.has(id)),
		"the block lost every entry it covered",
	);
	assert.equal(
		compaction.summary.includes("reproduced below"),
		false,
		"a block was orphaned that need not have been",
	);
});

test("emergency: a failed dump still compacts, with MODEL-FACING-TEXT.md §8's other note", () => {
	const entries = [...longSession()];
	const run = started(entries, () => undefined);
	const home = process.env.HOME;
	const fake = emptyProject();
	mkdirSync(join(fake, ".cache/pi/context-fold"), { recursive: true });
	writeFileSync(join(fake, ".cache/pi/context-fold/overflow"), "not a directory");
	process.env.HOME = fake;
	try {
		const compaction =
			compact(run, compactEvent(entries, "overflow")).compaction ?? assert.fail("no compaction");
		assert.match(
			compaction.summary,
			asPattern(note(1), [
				["1,830 messages", "[\\d,]+ messages"],
				["~412K tokens", "~\\d+(\\.\\d)?[KM] tokens"],
				["<reason>", ".+"],
				["<sessionFile>", "\\S+"],
			]),
		);
		assert.ok(
			entries.some((entry) => entry.id === compaction.firstKeptEntryId),
			"the cut point is not on the branch",
		);
	} finally {
		process.env.HOME = home;
		rmSync(fake, { recursive: true, force: true });
	}
});

/**
 * §8's fallback and the reason it exists. Pi turns a cancelled *automatic* compaction into a turn
 * that vanishes with nothing printed while the context is still over the window, so the handler may
 * not cancel — and the case is reachable: here the newest round alone is most of the view, so no
 * boundary frees half and the earlier version threw, which the handler turned into that cancel.
 */
test("emergency: with no boundary freeing half, the cut keeps only the newest round", () => {
	const entries: SessionEntry[] = [];
	messageEntry(entries, "u0", sample("user"));
	messageEntry(entries, "a0", assistantCalling("small-1"));
	messageEntry(entries, "r0", resultMessage("small-1", "small"));
	messageEntry(entries, "u1", sample("user"));
	messageEntry(entries, "a1", assistantCalling("big-1"));
	messageEntry(entries, "r1", resultMessage("big-1", "A".repeat(200_000)));

	const run = started(entries, () => undefined);
	const weigh = (messages: Msg[]) => messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	const slots = projectSlots(buildView(buildContextEntries(entries)), []);
	const grouped = rounds(slots);
	assert.equal(grouped.length, 2, "the fixture is not two rounds");
	assert.ok(
		weigh(
			grouped
				.slice(0, -1)
				.flat()
				.map((slot) => slot.message),
		) *
			2 <
			weigh(slots.map((slot) => slot.message)),
		"a boundary frees half here, so the fixture proves nothing",
	);

	const result = compact(run, compactEvent(entries, "overflow"));
	assert.equal(result.cancel, undefined, "the emergency path cancelled");
	const compaction = result.compaction ?? assert.fail("no compaction");
	assert.equal(compaction.firstKeptEntryId, "u1", "the cut did not keep exactly the newest round");
});

/** The one catch left that is not the file write: a throw here hands the turn to Pi's raw
 * summariser (§8), so the handler must answer even when the log is what failed. */
test("emergency: a log that cannot be written still yields a compaction", () => {
	const dir = withConfig({ logFile: emptyProject() });
	const entries = [...longSession()];
	const run = started(entries, () => undefined, dir);
	assert.throws(
		() => appendFileSync(loadConfig(dir).logFile, "x"),
		{ code: "EISDIR" },
		"the log write did not fail",
	);

	const compaction =
		compact(run, compactEvent(entries, "overflow")).compaction ?? assert.fail("no compaction");
	assert.ok(
		entries.some((entry) => entry.id === compaction.firstKeptEntryId),
		"the cut point is not on the branch",
	);
});

test("one token format, Pi's own footer rule", () => {
	assert.deepEqual(
		[0, 712, 3_100, 9_999, 10_000, 48_200, 412_000, 999_999, 1_000_000, 1_500_000].map(shortTokens),
		["0.0K", "0.7K", "3.1K", "10.0K", "10K", "48K", "412K", "1000K", "1.0M", "1.5M"],
	);
});
