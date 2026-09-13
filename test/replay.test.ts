import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resultLine } from "../src/compress.ts";
import { shortTokens, summaryMessage } from "../src/project.ts";
import { liveBlocks } from "../src/state.ts";
import { setFoldStatus } from "../src/status.ts";
import type { FoldBlock, Msg } from "../src/types.ts";

process.env.HOME = mkdtempSync(join(tmpdir(), "context-fold-home-"));

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

test("one token format, everywhere", () => {
	assert.deepEqual(
		[0, 712, 3_100, 9_999, 10_000, 48_200, 412_000, 999_999, 1_000_000, 1_500_000].map(shortTokens),
		["0.0K", "0.7K", "3.1K", "10.0K", "10K", "48K", "412K", "1000K", "1.0M", "1.5M"],
	);
});
