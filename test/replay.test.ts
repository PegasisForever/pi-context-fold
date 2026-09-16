import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerFold, tooShort, trackRun } from "../src/fold.ts";
import contextFold from "../src/index.ts";
import { INSTRUCTION } from "../src/menu.ts";
import { NUDGE_GROWTH_TOKENS, sendNudge } from "../src/nudge.ts";
import {
	NUDGE_CUSTOM_TYPE,
	projectSlots,
	RECEIPT_CUSTOM_TYPE,
	receiptText,
	shortTokens,
	summaryMessage,
} from "../src/project.ts";
import { liveBlocks } from "../src/state.ts";
import { setFoldStatus } from "../src/status.ts";
import type { FoldBlock, Msg } from "../src/types.ts";
import { buildView } from "../src/view.ts";

process.env.HOME = mkdtempSync(join(tmpdir(), "context-fold-home-"));
// Pi makes this directory; the tests drive the extension without Pi, and the fold log is written
// before anything else, so without it every fold throws at the first line of its own audit trail.
mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });

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

function unmark(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/^> ?/, ""))
		.join("\n");
}

function flat(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function userText(message: Msg): string {
	assert.equal(message.role, "user", "expected the summary to be a user message");
	if (message.role !== "user") throw new Error("unreachable");
	const content = message.content;
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "")).join("");
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
	// Without the retired calls, b1's own compact call comes back — and its arguments still carry
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
 * A1: a fold retires every nudge older than it. The nudge existed when the fold landed, so the
 * model has acted on it and its numbers are stale. No span mapping: creation order is enough, so a
 * spontaneous fold retires the same way. A nudge sent after the fold stays.
 */
test("A1: a fold retires every nudge older than it, and keeps newer ones", () => {
	const user = (text: string, timestamp: number): Msg =>
		({ role: "user", content: [{ type: "text", text }], timestamp }) as Msg;
	const assistant = (text: string, timestamp: number): Msg =>
		({ role: "assistant", content: [{ type: "text", text }], timestamp }) as Msg;
	const nudge = (timestamp: number): Msg =>
		({
			role: "custom",
			customType: NUDGE_CUSTOM_TYPE,
			content: "<pi-context-fold>old numbers</pi-context-fold>",
			display: true,
			timestamp,
		}) as Msg;
	const view = [
		{ entryId: "e-u1", message: user("old work", 10) },
		{ entryId: "e-n1", message: nudge(100) },
		{ entryId: "e-a1", message: assistant("working", 150) },
		{ entryId: "e-n2", message: nudge(300) },
		{ entryId: "e-u2", message: user("new work", 350) },
	];
	const folded = block({ id: "b1", entryIds: ["e-u1"], timestamp: 200 });

	const slots = projectSlots(view, [folded]);
	const kept = slots.map((slot) => slot.entryId ?? slot.block?.id);
	// The summary anchors at the folded entry, the pre-fold nudge is gone, the post-fold one stays.
	// (No receipt entry exists in this view, so none can show.)
	assert.deepEqual(kept, ["b1", "e-a1", "e-n2", "e-u2"]);

	// With no fold yet, every nudge stays: nothing has been acted on.
	const fresh = projectSlots(view, []);
	assert.deepEqual(
		fresh.map((slot) => slot.entryId ?? slot.block?.id),
		["e-u1", "e-n1", "e-a1", "e-n2", "e-u2"],
	);
});

/**
 * §4b: the receipt is a stored entry, so the log can confirm what the view showed, and it never
 * leaves the view — only a later fold that covers it can take it out. The 560d loop folded three
 * times on a live user order with fresh menus because the result leaves the view with its call
 * before the next request and the menu never says stopping is allowed; the receipt carries both the numbers and the stop rule to
 * exactly that choice. A note that expires is a note the next choice can be made without, which
 * is the same failure one step later, so it does not expire.
 */
test("§4b: the stored receipt stays in the view for every later answer", () => {
	const user = (text: string, timestamp: number): Msg =>
		({ role: "user", content: [{ type: "text", text }], timestamp }) as Msg;
	const assistant = (text: string, timestamp: number): Msg =>
		({ role: "assistant", content: [{ type: "text", text }], timestamp }) as Msg;
	const folded = block({
		id: "b1",
		entryIds: ["e-u1"],
		msgs: 5,
		tokensBefore: 412_000,
		tokensAfter: 3_100,
		timestamp: 200,
	});
	// The entry the fold sends, standing where sent entries stand: at the end.
	const receipt = {
		entryId: "e-rcpt",
		message: {
			role: "custom",
			customType: RECEIPT_CUSTOM_TYPE,
			content: `<pi-context-fold>\n${receiptText([folded])}\n</pi-context-fold>`,
			display: true,
			timestamp: 210,
		} as Msg,
	};
	const names = (view: { entryId: string; message: Msg }[]): string[] =>
		projectSlots(view, [folded]).map((slot) => slot.entryId ?? `summary ${slot.block?.id}`);
	const note = (view: { entryId: string; message: Msg }[]): string | undefined => {
		for (const slot of projectSlots(view, [folded])) {
			if (slot.entryId === "e-rcpt") {
				assert.equal(slot.message.role, "custom");
				if (slot.message.role !== "custom") throw new Error("unreachable");
				const content = slot.message.content;
				return typeof content === "string" ? content : "";
			}
		}
		return undefined;
	};
	const base = [
		{ entryId: "e-u1", message: user("old work", 10) },
		{ entryId: "e-a1", message: assistant("folding", 150) },
		receipt,
	];

	// No answer yet: summary, work, and the note with the numbers and the stop rule, no span ids.
	assert.deepEqual(names(base), ["summary b1", "e-a1", "e-rcpt"]);
	assert.match(
		note(base) ?? "",
		/<pi-context-fold>[\s\S]*You just compacted 5 messages into b1\. 412K → 3\.1K\.[\s\S]*Carry on with the user's work\.[\s\S]*<\/pi-context-fold>/,
	);
	assert.ok(!(note(base) ?? "").includes("e-u1"), "a receipt must not quote dead menu ids");

	// One answer (a menu round-trip): the note is still there for the fold decision.
	const once = [...base, { entryId: "e-a2", message: assistant("menu?", 250) }];
	assert.deepEqual(names(once), ["summary b1", "e-a1", "e-rcpt", "e-a2"]);
	assert.ok(note(once) !== undefined);

	// Two answers, and every answer after them: the note is still there. The decision it serves is
	// every later fold decision, not only the next one, so no count of answers retires it.
	const twice = [...once, { entryId: "e-a3", message: assistant("folding again", 300) }];
	assert.deepEqual(names(twice), ["summary b1", "e-a1", "e-rcpt", "e-a2", "e-a3"]);
	assert.ok(note(twice) !== undefined, "the record of a fold must not expire");
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

/** MODEL-FACING-TEXT.md §4, §4b and §6, built with the document's own example values so they compare whole. */
test("MODEL-FACING-TEXT.md §4, §4b and §6: the success result, the receipt and the summary wrapper are the document's", () => {
	const record = block({ id: "b5", msgs: 38, originalPath: "~/.pi/agent/context-fold/01a094/b5.txt" });
	// The backticks are the model's, not markdown: §4b's fenced block shows them literally.
	assert.equal(receiptText([record]), flat(quoted("4")));
	assert.equal(`<pi-context-fold>\n${receiptText([record])}\n</pi-context-fold>`, fenced("4b", 0));
	const second = block({
		id: "b6",
		msgs: 9,
		tokensBefore: 22_000,
		tokensAfter: 800,
		originalPath: "~/.pi/agent/context-fold/01a094/b6.txt",
	});
	assert.equal(`<pi-context-fold>\n${receiptText([record, second])}\n</pi-context-fold>`, fenced("4b", 1));

	// §3a: the instruction above the table, with the size target and the floor.
	assert.equal(INSTRUCTION, fenced("3", 0));
	// §5: the short-summary refusal, with the document's own numbers.
	assert.equal(
		tooShort([
			{ from: "e1", to: "e100", before: 191_520, after: 330 },
			{ from: "e101", to: "e150", before: 111_847, after: 3_600 },
		]),
		fenced("5", 0),
	);

	const message = summaryMessage({ ...record, summary: "…the model's summary text…" });
	// §6: the role is load-bearing. pi-ai reads a `user` message as interrupting a tool flow, which
	// is what turns a mis-placed summary into a provider rejection rather than a silent oddity.
	assert.equal(message.role, "user");
	assert.equal(userText(message), fenced("6"));
	// §6: the user's own messages, under the summary, one tag each.
	const withQuotes = summaryMessage({
		...record,
		summary: "…the model's summary text…",
		quotes: [
			"build it and run it locally and give me the link to the web ui",
			"add logcli, yq, duckdb, httpie into the docker image",
		],
	});
	assert.equal(userText(withQuotes), fenced("6", 1));
});

/**
 * MODEL-FACING-TEXT.md §7, §7a and §7b, sent through the real sender with the document's own
 * numbers. The nudges went untested once, and the code and the document drifted by a word.
 */
test("MODEL-FACING-TEXT.md §7, §7a and §7b: the three nudges are the document's, and only §7 waits", () => {
	const sent: { content: string; triggerTurn: boolean; deliverAs?: string }[] = [];
	const pi = {
		sendMessage: (message: { content: string }, options: { triggerTurn: boolean; deliverAs?: string }) =>
			sent.push({ content: message.content, ...options }),
	};
	const at = (tokens: number | null) => ({
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
	});
	sendNudge(pi as never, at(640_000) as never, "growth", NUDGE_GROWTH_TOKENS);
	sendNudge(pi as never, at(910_000) as never, "last", NUDGE_GROWTH_TOKENS);
	// §7b: Pi does not know the size right after a compaction, and the request never states it.
	sendNudge(pi as never, at(null) as never, "manual", NUDGE_GROWTH_TOKENS);
	sendNudge(pi as never, at(640_000) as never, "manual", NUDGE_GROWTH_TOKENS);

	assert.equal(sent[0]?.content, fenced("7", 0));
	assert.equal(sent[1]?.content, fenced("7", 1));
	assert.equal(sent[2]?.content, fenced("7", 2));
	assert.equal(sent[3]?.content, fenced("7", 2), "the request must not change with the size");
	assert.deepEqual(
		sent.map((one) => one.triggerTurn),
		[false, true, true, true],
	);
	// The last nudge and the request are steers, so neither waits for the model to stop. Pi reads
	// no delivery option for the growth reminder, which starts nothing, so it has none.
	assert.deepEqual(
		sent.map((one) => one.deliverAs),
		[undefined, "steer", "steer", "steer"],
	);
});

/**
 * The medi session: a fresh process, `/compact`, and the first real reply measures 576K where
 * Pi's estimate had said 218K. The growth clock counted that jump from its load-time 0 and sent a
 * reminder straight into the compaction you had just asked for. A request is a reminder already,
 * so the clock restarts from the first measurement after it — and still counts from there.
 */
test("/compact restarts the growth clock at the next measurement, and the clock still runs", () => {
	const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
	const sent: string[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers[name] = [...(handlers[name] ?? []), handler];
		},
		registerTool: () => {},
		registerMessageRenderer: () => {},
		appendEntry: () => {},
		sendMessage: (message: { content: string }) => sent.push(message.content),
	};
	contextFold(pi as never);
	let tokens = 0;
	const ctx = {
		getContextUsage: () => ({ tokens, contextWindow: 1_048_576 }),
		ui: { setStatus: () => {} },
		sessionManager: { getBranch: () => [], buildContextEntries: () => [], getSessionId: () => "s" },
	};
	const kinds = () =>
		sent.map((text) => (text.includes("The user has requested") ? "request" : "reminder"));
	const turnEnd = (at: number) => {
		tokens = at;
		for (const handler of handlers.turn_end ?? [])
			handler({ message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, ctx);
	};

	tokens = 218_000;
	const answer = handlers.session_before_compact?.[0]?.({ reason: "manual" }, ctx);
	assert.deepEqual(answer, { cancel: true });
	assert.deepEqual(kinds(), ["request"]);

	// The menu call's reply: the first real measurement. No reminder on top of the request.
	turnEnd(576_000);
	assert.deepEqual(kinds(), ["request"], "a reminder must not follow the request it repeats");

	// The model declined; growth is counted from 576K, not from 0 and not from the old 218K.
	turnEnd(775_000);
	assert.deepEqual(kinds(), ["request"]);
	turnEnd(776_000);
	assert.deepEqual(kinds(), ["request", "reminder"]);
});

test("one token format, everywhere", () => {
	assert.deepEqual(
		[0, 712, 3_100, 9_999, 10_000, 48_200, 412_000, 999_999, 1_000_000, 1_500_000].map(shortTokens),
		["0.0K", "0.7K", "3.1K", "10.0K", "10K", "48K", "412K", "1000K", "1.0M", "1.5M"],
	);
});

/**
 * DESIGN §17 row 19.59 listed three defects that withdrew the array of spans. It is back (§2a), and
 * this pins each one: overlapping spans are rejected whole, the arrival order changes nothing, and
 * nothing is appended to the session until every step that can throw has already run.
 */
/** A summary long enough to pass the 3% floor on the spans these tests fold (a round is ~500 tokens). */
const long = (text: string): string => `${text}: ${"a detail worth keeping, ".repeat(20)}`;

function driveCompact() {
	const entries: SessionEntry[] = [];
	let n = 0;
	const round = (tool: string, arg: string) => {
		n += 1;
		entries.push({
			type: "message",
			id: `x${n}a`,
			parentId: null,
			timestamp: "2026-09-12T00:00:00.000Z",
			message: {
				role: "assistant",
				timestamp: n,
				content: [{ type: "toolCall", id: `c${n}`, name: tool, arguments: { path: arg } }],
			},
		} as unknown as SessionEntry);
		entries.push({
			type: "message",
			id: `x${n}b`,
			parentId: null,
			timestamp: "2026-09-12T00:00:00.000Z",
			message: {
				role: "toolResult",
				timestamp: n,
				toolCallId: `c${n}`,
				toolName: tool,
				content: "y".repeat(2000),
				isError: false,
			},
		} as unknown as SessionEntry);
	};
	for (const name of ["a", "b", "c", "d", "e", "f", "g"]) round("read", `src/${name}.ts`);

	const appended: FoldBlock[] = [];
	let tool: {
		execute: (
			id: string,
			params: unknown,
			signal: unknown,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<{ content: { text: string }[]; terminate?: boolean }>;
	};
	const pi = {
		registerTool: (definition: unknown) => {
			tool = definition as typeof tool;
		},
		appendEntry: (_type: string, data: FoldBlock) => {
			appended.push(data);
		},
		// The fold's receipt lands here, exactly as `sendMessage` lands it in a live session:
		// a stored entry, observable in the log whether or not the view still shows it.
		sendMessage: (message: { customType: string; content: string }) => {
			entries.push({
				type: "custom_message",
				id: `rcpt-${entries.length}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: message.customType,
				content: message.content,
				display: true,
			} as unknown as SessionEntry);
		},
	};
	const handlers: Record<string, ((event: unknown) => unknown)[]> = {};
	const on = (name: string, handler: (event: unknown) => unknown) => {
		handlers[name] = [...(handlers[name] ?? []), handler];
	};
	const state = {
		menu: undefined,
		menuAt: 0,
		folded: false,
		baseline: 0,
		reported: new Set<string>(),
		working: false,
		compactOnly: false,
		refused: false,
	};
	registerFold(pi as never, state);
	trackRun({ on } as never, state);
	const emit = (name: string, event: unknown) => {
		for (const handler of handlers[name] ?? []) handler(event);
	};
	const ctx = {
		sessionManager: {
			buildContextEntries: () => entries,
			getBranch: () => appended.map((one, i) => customEntry(`k${i}`, "fold-block", one)),
			getSessionId: () => "test-session",
		},
	};
	const call = (params: unknown) => tool!.execute("call-1", params, undefined, undefined, ctx);
	return { call, appended, state, entries, emit };
}

test("§2a: two spans in one call, and every one of the three defects is refused", async () => {
	const { call, appended, state, entries } = driveCompact();
	await call({});
	assert.ok((state.menu as unknown as { entries: unknown[] }).entries.length >= 4, "need four entries");

	// Defect 1: overlapping spans. Rejected whole — nothing is written, nothing is appended.
	await assert.rejects(
		call({
			spans: [
				{ from: "e1", to: "e3", summary: "one" },
				{ from: "e3", to: "e4", summary: "two" },
			],
		}),
		/overlap/,
	);
	assert.equal(appended.length, 0, "a rejected call must append nothing");

	// Defect 2: order. The same two spans, given backwards, give the same blocks in view order.
	const result = await call({
		spans: [
			{ from: "e4", to: "e5", summary: long("later work") },
			{ from: "e1", to: "e2", summary: long("earlier work") },
		],
	});
	assert.equal(appended.length, 2);
	assert.deepEqual(
		appended.map((one) => one.id),
		["b1", "b2"],
	);
	assert.equal(appended[0]?.summary, long("earlier work"), "b1 must be the earlier span");
	assert.deepEqual(
		appended.flatMap((one) => one.entryIds).sort(),
		[...new Set(appended.flatMap((one) => one.entryIds))].sort(),
		"two blocks must not claim the same entry",
	);
	// One call, one text, one record: the lines in view order, the closing sentence once.
	const text = result.content[0]?.text ?? "";
	assert.match(
		text,
		/^You just compacted \d+ messages into 2 blocks\. [^\n]*\n- b1: [^\n]*\n- b2: [^\n]*\nCarry on/,
	);
	assert.equal(text.match(/Carry on/g)?.length, 1);
	const receipts = entries.filter(
		(e) => e.type === "custom_message" && e.customType === RECEIPT_CUSTOM_TYPE,
	);
	assert.equal(receipts.length, 1, "one record per compact call, not one per block");
	assert.equal(
		(receipts[0] as { content?: string }).content,
		`<pi-context-fold>\n${text}\n</pi-context-fold>`,
	);

	// Defect 3: the transcript of every block exists before any of them is appended.
	for (const one of appended) assert.ok(readFileSync(one.originalPath, "utf8").length > 0, one.id);
});

/**
 * §7b: a fold ends the run only when the run exists to compact — our request arrived with no task
 * in progress, and nothing asked for work since. Replayed live on the medi session, the model asked
 * for one more reply after such a fold carried on in 4 of 6 runs. The last nudge is a steer and can
 * land mid-task, where ending the run would cut your work short.
 */
test("§7b: a fold ends the run only when the run exists to compact", async () => {
	const request = (kind: string) => ({
		message: {
			role: "custom",
			customType: NUDGE_CUSTOM_TYPE,
			content: "…",
			details: { lines: [], kind },
		},
	});
	const reply = (calls: boolean) => ({
		message: {
			role: "assistant",
			content: calls
				? [{ type: "toolCall", id: "t", name: "bash", arguments: {} }]
				: [{ type: "text", text: "done" }],
		},
	});
	const user = { message: { role: "user", content: "next task" } };
	const other = { message: { role: "custom", customType: "pi-background", content: "job finished" } };
	const foldAfter = async (events: [string, unknown][]) => {
		const { call, emit } = driveCompact();
		for (const [name, event] of events) emit(name, event);
		const menu = await call({});
		assert.notEqual(menu.terminate, true, "the menu call never ends the run");
		return (await call({ spans: [{ from: "e1", to: "e1", summary: long("done") }] })).terminate === true;
	};
	const idle: [string, unknown] = ["agent_end", {}];

	assert.equal(await foldAfter([idle, ["message_end", request("manual")]]), true, "/compact while idle");
	assert.equal(
		await foldAfter([
			["turn_end", reply(false)],
			["message_end", request("last")],
		]),
		true,
		"the last nudge after the final answer",
	);
	assert.equal(
		await foldAfter([
			["turn_end", reply(true)],
			["message_end", request("last")],
		]),
		false,
		"the last nudge mid-task: your work goes on",
	);
	assert.equal(
		await foldAfter([["turn_end", reply(true)], idle, ["message_end", request("manual")]]),
		true,
		"a run that ended on a tool call is still over",
	);
	assert.equal(
		await foldAfter([idle, ["message_end", request("manual")], ["message_end", user]]),
		false,
		"your message after the request is work",
	);
	assert.equal(
		await foldAfter([idle, ["message_end", request("manual")], ["message_end", other]]),
		false,
		"another extension's message is work",
	);
	assert.equal(
		await foldAfter([
			["message_end", user],
			["turn_end", reply(true)],
		]),
		false,
		"a fold during your work",
	);
	assert.equal(
		await foldAfter([idle, ["message_end", request("growth")]]),
		false,
		"a growth reminder starts nothing",
	);
	assert.equal(
		await foldAfter([idle, ["message_end", request("manual")], idle]),
		false,
		"the run the request started is over",
	);
});

/**
 * §5: a summary under 3% of what it replaces is refused whole, before anything is written — one
 * model folded 112K into 110 tokens on every call. The list stays current, so the retry needs no
 * second menu.
 */
test("§5: a first summary under 3% is refused with nothing written, and the second try lands with no new menu", async () => {
	const { call, appended, entries, emit } = driveCompact();
	// Each call arrives in an assistant message of its own, as in a live session: the menu's ids
	// are fresh for the message after it, and only the refusal keeps them fresh one message longer.
	let n = 90;
	const message = () =>
		entries.push({
			type: "message",
			id: `m${n}`,
			parentId: null,
			timestamp: "2026-09-12T00:00:00.000Z",
			message: {
				role: "assistant",
				timestamp: n++,
				content: [{ type: "text", text: "calling compact" }],
			},
		} as unknown as SessionEntry);
	message();
	await call({});
	const receipts = () => entries.filter((e) => e.type === "custom_message").length;
	message();
	await assert.rejects(
		call({
			spans: [
				{ from: "e1", to: "e2", summary: "too short" },
				{ from: "e4", to: "e4", summary: long("long enough") },
			],
		}),
		(error: Error) => {
			assert.match(error.message, /^Nothing was compacted: a summary must be at least 3% /);
			assert.match(error.message, /\n- e1–e2: \d+ tokens for [\d,]+ \(0\.\d%\)\. Write at least /);
			// The long enough span is named too, or the model resends only the short one.
			assert.match(
				error.message,
				/\n- e4–e4: \d+ tokens for [\d,]+ \([\d.]+%\)\. Long enough: send it again unchanged\.\n/,
			);
			assert.match(
				error.message,
				/\nNothing was saved\. Send every span listed here again, in one call\.$/,
			);
			return true;
		},
	);
	assert.equal(appended.length, 0, "a refused call must append nothing");
	assert.equal(receipts(), 0, "and send no record");

	// The model's next message retries with the same ids and no new menu. The second try lands
	// whatever its size: a model that stalls under the floor would otherwise never fold at all.
	message();
	await call({ spans: [{ from: "e1", to: "e2", summary: "still short" }] });
	assert.equal(appended.length, 1);
	assert.ok(appended[0]!.tokensAfter < appended[0]!.tokensBefore * 0.03);

	// A fold landed, so the next one gets its own first try.
	message();
	await call({});
	message();
	await assert.rejects(
		call({ spans: [{ from: "e3", to: "e3", summary: "short" }] }),
		/^Error: Nothing was compacted/,
	);

	// A run that ends clears the refusal too: the next run starts with a first try.
	emit("agent_end", {});
	message();
	await call({});
	message();
	await assert.rejects(
		call({ spans: [{ from: "e3", to: "e3", summary: "short" }] }),
		/^Error: Nothing was compacted/,
	);
	message();
	await call({ spans: [{ from: "e3", to: "e3", summary: "short again" }] });
	assert.equal(appended.length, 2);
});

/**
 * §6: the fold keeps the user's own words, not the model. Asked to quote every message, one model
 * kept 36 of 200. Every text part is kept as sent, and a later fold that absorbs this one keeps
 * them where the summary stood.
 */
test("§6: a fold stores the user's messages word for word and shows them under the summary, through absorption", async () => {
	const { call, appended, entries } = driveCompact();
	const user = (id: string, content: unknown): SessionEntry =>
		({
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-09-12T00:00:00.000Z",
			message: { role: "user", content, timestamp: 1 },
		}) as unknown as SessionEntry;
	const sent = "<system-reminder>Selected context: src/a.ts L1-L9</system-reminder>\nwhy is this slow?";
	// Each opens the round after it: before rounds 1 and 2.
	entries.splice(
		2,
		0,
		user("u2", [
			{ type: "text", text: sent },
			{ type: "image", data: "…", mimeType: "image/png" },
		]),
	);
	entries.splice(0, 0, user("u1", "build it and run it locally"));

	await call({});
	await call({ spans: [{ from: "e1", to: "e3", summary: long("first three rounds") }] });
	const first = appended[0]!;
	assert.deepEqual(first.quotes, ["build it and run it locally", sent]);
	assert.ok(
		first.tokensAfter > Math.ceil(long("first three rounds").length / 4) + 20,
		"the quotes count toward the summary's size",
	);

	const shown = (): string =>
		projectSlots(
			buildView(entries),
			liveBlocks({
				getBranch: () => appended.map((one, i) => customEntry(`k${i}`, "fold-block", one)),
			}),
		)
			.map((slot) => (slot.block ? userText(slot.message) : ""))
			.join("");
	assert.ok(
		shown().includes(
			`first three rounds: ${"a detail worth keeping, ".repeat(20)}\n\n<user-message>build it and run it locally</user-message>\n<user-message>${sent}</user-message>\n</summary>`,
		),
	);

	// A later fold takes b1's summary and the next round, with a new message of the user's in it.
	entries.splice(
		entries.findIndex((e) => e.id === "x4a"),
		0,
		user("u4", "now make it fast"),
	);
	await call({});
	await call({ spans: [{ from: "e1", to: "e2", summary: long("everything so far") }] });
	const second = appended[1]!;
	assert.deepEqual(second.blockIds, ["b1"]);
	assert.deepEqual(second.quotes, [...(first.quotes ?? []), "now make it fast"]);
	assert.match(
		shown(),
		/everything so far[\s\S]*<user-message>build it and run it locally<\/user-message>[\s\S]*<user-message>now make it fast<\/user-message>/,
	);
});

test("§2a: a span is refused when the list it names is no longer in the view", async () => {
	const { call, entries } = driveCompact();
	await call({});
	// Two more assistant messages: the menu result has left the view, so its ids name nothing visible.
	for (const id of ["late1", "late2"]) {
		entries.push({
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-09-12T00:00:00.000Z",
			message: { role: "assistant", timestamp: 99, content: [{ type: "text", text: "thinking" }] },
		} as unknown as SessionEntry);
	}
	await assert.rejects(call({ spans: [{ from: "e1", to: "e2", summary: "x" }] }), /not the current one/);
});

/**
 * The 560d loop: told to compact, the model folded three times on fresh menus (187, 65, 20
 * entries) because the result leaves the view before the next request and nothing said when to
 * stop. Replays one fold through the real tool and reads the next decision's view back: the example that caused the
 * first failure names spans, the stale nudge is gone (A1), the receipt with the stop rule stands
 * behind the summary (§4b), and no tool result is ever left without its call.
 */
test("560d replay: after a fold every later view carries the stored receipt, no nudge, no orphans", async () => {
	const { call, appended, entries } = driveCompact();
	// The standing reminder, sent long before the fold (timestamp predates the fold's).
	entries.push({
		type: "custom_message",
		id: "nudge-old",
		parentId: null,
		timestamp: "1970-01-01T00:00:00.050Z",
		customType: NUDGE_CUSTOM_TYPE,
		content: "<pi-context-fold>200K of 872K context used.</pi-context-fold>",
		display: true,
	} as unknown as SessionEntry);

	const menu = await call({});
	assert.ok(
		menu.content[0]?.text.includes('compact({spans: [{from: "e1"'),
		"the menu example must name spans, or the model omits the wrapper again",
	);

	const result = await call({ spans: [{ from: "e1", to: "e2", summary: long("earlier work") }] });
	assert.equal(appended.length, 1);
	// Pin the fold between the old nudge and the next answers, whatever the wall clock says.
	appended[0]!.timestamp = 100;

	const assistant = (id: string, timestamp: number) =>
		entries.push({
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-09-12T00:00:00.000Z",
			message: { role: "assistant", timestamp, content: [{ type: "text", text: "next" }] },
		} as unknown as SessionEntry);
	const pairsIntact = (): void => {
		const calls = new Set<string>();
		for (const slot of projectSlots(buildView(entries), appended)) {
			const message = slot.message;
			if (message.role === "assistant") {
				for (const part of message.content) if (part.type === "toolCall") calls.add(part.id);
			} else if (message.role === "toolResult") {
				assert.ok(calls.has(message.toolCallId), `orphan result for ${message.toolCallId}`);
			}
		}
	};
	const receipt = (): string | undefined => {
		for (const slot of projectSlots(buildView(entries), appended)) {
			const message = slot.message;
			if (message.role === "custom" && message.customType === RECEIPT_CUSTOM_TYPE) {
				const content = message.content;
				return typeof content === "string" ? content : "";
			}
		}
		return undefined;
	};
	const receiptEntry = (): SessionEntry | undefined =>
		entries.find((e) => e.type === "custom_message" && e.customType === RECEIPT_CUSTOM_TYPE);
	const hasNudge = (): boolean =>
		projectSlots(buildView(entries), appended).some(
			(slot) => slot.message.role === "custom" && slot.message.customType === NUDGE_CUSTOM_TYPE,
		);

	// The next decision (one menu round-trip later): summary, stored receipt with the stop rule,
	// no nudge. The receipt is sent by the tool itself, so the log holds it either way.
	assistant("after-fold", Date.now() + 10_000);
	const logged = receiptEntry();
	assert.ok(logged !== undefined, "the fold must send a receipt entry, not just derive one");
	const note = receipt();
	assert.match(note ?? "", /You just compacted \d+ messages into b1\./);
	assert.match(note ?? "", /Carry on with the user's work\./);
	// One text, one function: the result the tool returned is the receipt, word for word.
	assert.equal(note, `<pi-context-fold>\n${result.content[0]?.text}\n</pi-context-fold>`);
	assert.match(note ?? "", /Full transcript is saved at: `\S+\/b1\.txt`\n/);
	assert.equal(hasNudge(), false, "a pre-fold nudge must not sit beside fresh folds");
	pairsIntact();

	// Two answers later, which is where the 560d loop asked for its third menu: the note is still
	// there, next to the summary it belongs to, and no pair has been broken to keep it.
	assistant("later", Date.now() + 20_000);
	assert.match(receipt() ?? "", /Carry on with the user's work\./);
	assert.ok(receiptEntry() !== undefined, "in the view and in the log");
	assert.ok(
		projectSlots(buildView(entries), appended).some((slot) => slot.block?.id === "b1"),
		"the summary stands beside its receipt",
	);
	pairsIntact();
});
