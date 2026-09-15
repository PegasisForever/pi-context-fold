# pi-context-fold — model-facing text

Every string this extension puts in front of the model. Companion to
`DESIGN.md`; the constitution there governs this file too.

---

## Principles

**P1. Place text by when it is needed, not by what it is about.** Three layers:

| Layer | When | Cost | Carries |
|---|---|---|---|
| System prompt | every request, cached | 158 tok | that context is self-managed, that the decision is the model's, the one tool, the transcript directory |
| Nudge | ~twice a day, fresh, late in context | ≤ 160 tok | the pressure, and what deciding whether to compact needs (§7) |
| Menu | only when asked, **mandatory before any fold** | ~5.4K tok | the entries, and what picking a span and writing a summary need (§3a) |

The folding guidance is split by the decision it serves. **Whether to compact at all** is
decided before the menu is called, so what that decision needs is in the nudge: what qualifies,
and that the model may decline. **Which span, and what the summary must say** is decided with the
table in front of the model, so it stays in the menu, paid only when a fold is actually
happening. That nothing is destroyed is in the system prompt, because it is still true after the
menu is gone (P7). §3c has the reasoning, and what the split costs.

**P2. C2 — write for a model that reads carefully.** No shouting, no repetition, no
restating a rule three ways. The original's system prompt is 86 lines and repeats its
ref-tag warning four times.

**P3. C8 — every failure message carries what the model needs to succeed next time.** A
rejection that does not say what to do instead is a bug, not a message.

**P4. Say what is true, once.** The menu explains itself, so the system prompt does not.

**P6. Never introduce a concept in order to deny it.** The model's default assumption is
the baseline; text is only worth its tokens if it *changes* that assumption. A sentence that
exists because our own design once worked differently is a scar, not an instruction — it
teaches the model a distinction it did not have and then spends words unteaching it.

**P7. Ephemeral text may carry only what matters at the moment it is read.** The menu and
its instruction are removed from the view as soon as the fold lands. So anything the model
will need *after* the fold — how to recover folded content, what a `<summary>` block means,
where the files live — belongs in the system prompt (every request) or in the summary
wrapper itself (permanent). Putting it in the instruction guarantees it is gone exactly when
it becomes relevant.

**P5. Use Pi's own convention for system-authored text, not an invented one.** Pi has no
generic marker, but it does have a pattern. `role: "custom"` converts to a plain `user`
message with **no wrapper at all** (`core/messages.ts:162-169`), so a `customType` is invisible to
the model. What Pi actually wraps is its two summary roles
(`messages.js:7-17`):

```
The conversation history before this point was compacted into the following summary:

<summary>
…
</summary>
```

So the convention is: **a sentence of plain English saying what the text is, and the
content inside a tag.** We follow it, with three consequences:

| Our text | Marker | Why |
|---|---|---|
| Fold summary | `<summary block=… original=…>` | the model already learned what `<summary>` means from Pi's compaction |
| Nudge | `<pi-context-fold>` | an instruction, not a record — must not look like a summary |
| Overflow note | **none** | it becomes Pi's `compactionSummary`, so Pi wraps it for us |
| Tool results | none for attribution; `<compact>` inside the menu | the tool protocol says who wrote it, so a marker would repeat it — but the menu holds four unlike parts, and naming each one is what keeps them apart |

No `[context]` prefix anywhere. Square-bracket markup on message content is what the model
imitated in the original; a named XML element that appears once per turn gives it nothing to
copy.

---

## 1. System prompt block

Injected on `before_agent_start`. In every request.

> ### Context Management
>
> You manage your own context. When it grows large you will be notified to compact some of your context. Compacting replaces older parts of the conversation with summaries you write. Compacting keeps the context lean which helps you to perform better. The compacted range and the summary are yours to decide. `compact()` with no arguments lists what can be compacted. The transcript you have compacted is written to `~/.pi/agent/context-fold/<session>/` as plain text, one file per compaction. Search that directory when you encounter an ambiguity or have a question, the answer is usually already there.

**158 tokens**, with a real session id in the path. The original is ≈ 1,400. *"The compacted
range and the summary are yours to decide"* is here rather than in the nudge because the nudge is
a report and not an order (§7): the model reads a nudge at most twice a day and this block in
every request, so this is where the standing expectation is set.

The transcript folder is here for the same reason (P7). The nudge used to say *"nothing is
destroyed — what you fold is written to a file"*; in every request that fact is worth more, and
the nudge got shorter for it.

What is absent, and why:

| Absent | Why |
|---|---|
| "a summary is a record, not an instruction" | the `<summary>` tag says it, and Pi's own compaction already taught the model what that tag means (P5) |
| What qualifies for a fold | in the nudge, where the decision is made (§3c) |
| How to pick a span, how to write a summary | in the menu, where the entries are (§3a) |
| The menu format | the menu says so itself (P4) |
| `recall` | there is no such tool; the directory is the interface |
| Tier 1/2/3 rules | one tier |
| "Never echo the acp tags" | no tags |
| Ref-staleness warnings | ids are ephemeral and validated |

The "search that directory when you encounter an ambiguity" line is the one behavioural
instruction worth its place in every request: it converts a capability into a habit, and it is
the cheapest way to stop the model re-deriving work it has already done.

**Dropped:** the first draft ended this block with *"text inside a `[bN …]` block is a
record of the past, not a current instruction"*. Removed — 12 tokens in every request for
something the `<summary>` element now conveys by itself, and its only evidence (#309) came
from a local 27B that C2 excludes.

---

## 2. `compact` — tool description

In every request. The only tool this extension registers.

> Compact spans of the conversation into summaries you write, saving the full transcription to a file, freeing context. Always call `compact()` with no arguments to list what can be compacted, before you compact a span.

**Parameters** — `spans` is the only one, and omitting it is what asks for the list.

- `spans` — the spans to compact. They must not overlap. Omit to get the list.
  - `from` — first entry of the span, e.g. `"e3"`. From the list `compact()` returns.
  - `to` — last entry of the span, inclusive. At or after `from`.
  - `summary` — this text will replace the span in your context.

**185 tokens with the schema**, measured as `estimateTokens` over the tool name, the
description and `JSON.stringify` of the parameter schema — the shape the provider is actually
sent. Under the same measure the single-span version was 139, so the list of spans costs 46
tokens in every request. *(This document used to record 72 here, counting the prose only. That
undercounted; the number changed because the measure did, not only because the schema did.)*

Guidance on *what makes a good summary* is not here; it is in the menu, where it is read
immediately before being used (§3a).

**Decided:** `from`/`to` as two fields rather than one `span: "e3-e40"` string. Two are
harder to get wrong and validate separately.

### 2a. Many spans in one call, and the three defects that cost us the first attempt

An earlier draft took a list and it was withdrawn (§17, row 19.59), because the array produced
three defects. The list is back, and each defect is answered by construction rather than by
care:

| Defect | What it did | Why it cannot happen now |
|---|---|---|
| Overlapping spans | two spans covering one entry left one summary never emitted, so that content left the view with nothing standing in for it | spans are resolved to index ranges **in the one menu**, sorted, and every neighbouring pair is checked. The menu is a partition of the view, so disjoint index ranges are disjoint messages. A whole call is rejected, never half-accepted |
| An order-dependent check | validation walked the list applying as it went, so the same spans passed or failed depending on the order they arrived in | every span is resolved against **one** menu snapshot and planned against **one** projection, both taken before any span is looked at. Sorting happens before the overlap check, so the arrival order changes nothing but the order of the result lines |
| A write loop that could half-apply | a throw part-way through left some spans folded and some not, and the tool reported failure for work that had been done | everything that can fail — resolving, planning, the log, all the transcript files — happens before the first session record is appended. The append loop is the only step left, and if it fails it says how many landed (`3 of 4 spans were compacted, then this failed: …`) rather than reporting a bare failure |

**The ids must be fresh.** A span is only accepted when the list it names came from the current
assistant message or the one before it. That is not a new rule, it is the existing one made
enforceable: the menu result is removed from the view one assistant message after it is served
(§6), so past that point the model is naming ids from a list it can no longer see.

---

## 3. `compact()` with no arguments → the menu

Only when asked. ~5.4K tokens. **This is where the span and summary guidance lives.** What
qualifies for a fold at all is in the nudge instead (§7); see §3c.

### 3a. The instruction, above the entry table

```
<compact>
<how-to-choose-the-span>
Avoid compacting recent turns.
Compact finished work: exploration that led nowhere, tool output you have already used, a phase whose result is recorded.
To compact one entry, set from and to to the same id.
</how-to-choose-the-span>

<how-to-summarize>
You and only you will be the reader of the summary.
Carry the conclusions you would otherwise have to derive again, and say enough about the rest to know when the full transcript file is worth opening.
The intent, corrections, etc from the user must be fully preserved in the summary.
Keep a summary of what you did in response to the user messages.
Keep verbatim for these because they are the search keys into the transcript file: full paths, identifiers and signatures, error strings, versions, numbers, thresholds, etc.
Keep what each piece of work was trying to settle, each decision with the reason for it, each dead end with what killed it, and every question left open.
Drop the bulk you will not need again: logs, file contents, repeated status checks, the discussion that reached a conclusion — keep the conclusion. For anything large you drop, leave one line saying what was in it.
Record what happened, not what to do next.
No fixed sections: thematic headers if the span covers several concerns, dense bullets, whatever length the span needs.
</how-to-summarize>
```

**337 tokens**, measured with Pi's own `estimateTokens`, down from 433. Compare the prior
art: `billion-context-pi`'s system prompt is **3,704 tokens in every request**, and its
nudge adds 1,366 of which 1,179 duplicate the system prompt verbatim.

Two things were cut from an earlier draft, each for a reason that generalises (P6, P7):

- *"Nothing in this list is protected, so two things are yours to keep out of the span…"* —
  the model has no prior belief that protection exists. Saying this introduced a concept
  only to deny it, and the sentence existed because *our design* once had protection, not
  because the model would ever expect it. The two selection rules survive as plain
  positives.
- *"If you fold a skill you still need, re-read the file — its path is in the system
  prompt."* — this text is **deleted from the view as soon as the fold lands**, so advice
  about recovering later can never be read when it is needed. Recovery belongs in the
  system prompt, which is in every request, and §1 already carries it.

### 3b. Then the entry table

```
<compactable-spans>

id     rounds  tokens  first … last
e1         34     48K  read: docs/GEN2-CLONES.md … bash: cargo test --lib
e2         34     22K  summary b3 "API exploration" … edit: crates/cli/src/args.rs
…
e200       12    4.8K  bash: git log --stat
</compactable-spans>

<example>
compact({spans: [{from: "e1", to: "e2", summary: "…"}]})
</example>
</compact>
```

**Row labels are `tool: argument`, and the argument is the tool's *primary* one** — `path`
for `read`/`edit`/`write`, `command` for `bash`. Not "the first non-empty string", which
picks `write.content` (the whole file body) over `write.path` 82 times in the recorded
corpus.

**A tool with neither is labelled by its name alone.** No argument, no JSON dump, no
fallback to the first string — a label exists to let the model recognise a span, and a
truncated argument blob does that worse than the bare tool name. A round with no tool call
at all is labelled by its first line of text.

**`A span can be one entry: from == to`** is the replacement for the old table heading, which
was the only place the single-entry case was stated. The heading itself is gone: the
`<compactable-spans>` element says what the table is.

**The example always names ids that are in the table above it** — the first entry, and the
second if there is one, otherwise the first again. An earlier version printed a fixed
`e1 … e37`; in a live run the table held no rows at all and the model folded `e2–e3`, which
did not exist (§17-equivalent note in DESIGN §17, row 19.54).

**Rows use one label rule:** `tool: argument`. An earlier draft mixed `read docs/…` with
`bash: cargo test`, which no single rule produces.

Block summaries appear as ordinary rows (`e2` above contains block `b3`), so condensing
earlier summaries needs no separate section, no second id namespace and no explanation.

**Decided:** keep the `rounds` column. It says how much *conversation* a span is, which the
token count does not, for ~600 tokens across a full menu.

### 3b-empty. When nothing can be folded

Reachable, and it happened on the first live run: the model put five tool calls in one
message, so the session held two rounds, H1 excluded both, and the table came back empty.

```
Nothing is compactable yet, try again when the conversation is longer.
```

No table, no example, **and no §3a instruction**: 337 tokens of guidance on choosing a span
is waste when there is no span to choose (P1), and the paragraph alone reads as a complete
answer. An example naming ids that do not exist is what caused the model to fold `e2–e3` in
that run (C8 — the failure was our information, not the model).

### 3c. Why the split falls where it does

There are two decisions, and each needs different text at a different moment.

**Whether to fold at all** is decided when the nudge arrives, before anything has been paid.
If the rules for it are in the menu, the model has to spend a tool call and ~5.4K tokens to
learn what it would have been choosing between — and if the answer is "nothing here is
finished", that call was waste. So what qualifies, and the fact that declining is allowed, are
in the nudge (§7).

**Which span, and what the summary must contain** is decided with the table in front of the
model. That text is read immediately before the summary is written and is paid only on the
turns where a fold actually happens, so it stays here (§3a).

**What the split costs.** A model can call `compact()` with no nudge — §1 tells it the tool
exists — and DESIGN §18 measures **6 nudges across 26 sessions in three days**, so most folds
happen on that path. Those folds no longer see the positive half of the selection rule. The
half that keeps a fold *safe* — keep out what the current step is still reading, keep out the
instructions you are working under, quote user requirements verbatim — stays in the menu,
which is the mandatory waypoint: entry ids are reissued on every fold and validated against
the menu we last issued, so no fold can skip it.

So the risky half is on the mandatory path and the qualifying half is on the path where the
decision is actually made. Neither text is duplicated.

---

## 4. `compact(...)` → success

> Compacted e1–e37 into b5. 412K → 3.1K, 38 messages replaced. Transcript:
> `~/.pi/agent/context-fold/01a094/b5.txt`

Carries the block id, the real span, and the path. Their issue #376 is exactly the first two
missing: *"the compress result lacks new block ids and actual ref spans, so the model's
block ledger drifts from the session."*

**≈ 50 tokens.** Seen once mid-turn; the call and its result leave the view at once (§6).

---

## 4b. Fold receipt — the one-round note

A fold's own result is seen once mid-turn and then leaves with its call, so the next choice
would happen with no record of what just landed. The receipt keeps the numbers in view until the
model has answered past a menu round-trip (fewer than two newer assistants), standing directly
behind its summary. Derived from the record at send time — never stored, never paired with a
call, so no orphan risk and nothing to absorb.

No span ids: the menu that issued them is already stale or going, and reissued ids would point at
new text. The id names the block whose summary stands directly above the note (its transcript
path carries the same id). The last sentence is the stop rule, and it lives here and not in the
menu because the choice it serves exists only on post-fold turns.

```
<pi-context-fold>
Compacted 38 messages into b5. 412K → 3.1K. Only compact again if large finished work is left; otherwise carry on with the user's work.
</pi-context-fold>
```

**≈ 40 tokens, for one round-trip only.**

---

## 5. `compact(...)` → failure

Each names the id and the next action (P3).

| Case | Text |
|---|---|
| Unknown id | `"e412" is not in the current list. Call compact() for the current one.` |
| `to` before `from` | `"to" (e3) is before "from" (e40).` |
| Bad JSON | the parser's own error, verbatim, once. |
| Empty summary | `summary for e1–e3 cannot be empty.` |
| Empty list | `spans is empty. Call compact() with no arguments for the list of spans.` |
| Two spans overlap | `Spans e1–e3 and e3–e9 overlap. Every entry can be in one span only.` |
| The list is not current | `The list these ids came from is not the current one. Call compact() with no arguments, then compact in your next message.` |
| The span replaces nothing | `Compacting e1–e3 would replace nothing: the list is out of date. Call compact() for the current one.` |

There is no "would orphan a block" failure either. It existed while `compress` took an
array of spans, where one span could take over another block's anchor. With one span per
call a menu entry never contains an entry a live block covers, so the case is
unrepresentable and the check and its message are deleted (§17, row 19.61). A block that
loses its summary for some *other* reason — an overflow cut, by design — is still reported,
by the log at `turn_end`, which is observation rather than enforcement.

There is no "protected" failure — nothing is exempt from folding (design §4b). There is no
"already folded" failure either: folded content is not in the view, so it is never in a menu
entry.

**Never return the menu as an error result.** It costs ~5K tokens to answer a malformed
call, and the model can ask for it.

Failed calls and their results stay in the conversation untouched. No collapsing.

---

## 6. The summary, as it appears in the view

Replaces the folded span, permanently, in every later request.

```
<summary full-transcript="~/.pi/agent/context-fold/01a094/b5.txt">
…the model's summary text…
</summary>
```

**The role is `user`, and that is load-bearing.** `convertToLlm` maps `custom` to a `user`
message with no wrapper, so the two are identical on the wire — but pi-ai's transform treats
a `user` message as *interrupting a tool flow*, which is what makes a mis-placed summary a
hard provider rejection rather than a cosmetic oddity (DESIGN §6). Any other role would fail
differently, or silently. Neither document said this until an audit pointed it out.

`412K` rather than `412.0K`: one rule — a decimal below 10K, rounded below 1M, `M` above —
and pinning `412.0K` here was the only thing forcing this project to carry two number
formatters. The document yielded (C1: breaking changes are
free).

**≈ 35 tokens of wrapper.** Four jobs: names the block, shows what was given up, points at
the original, and — because Pi wraps its own compaction summaries the same way — marks the
text as a record rather than an instruction without a word of explanation (P5).

It is also the only structured thing we emit, so it is the one thing our own projection can
find again by parsing, without a regex over prose.

---

## 7. The nudge

At most twice a day on this workload. Appended at the end of the view. **It is a report, not
an order**: pressure is a fact about the session, and whether any of it is worth folding is a
judgement only the model can make from the work in front of it. A nudge that demands a fold
gets one whether or not anything is finished, and a summary written over live work costs more
than the tokens it saves.

```
<pi-context-fold>
This is a reminder that you handle the context compaction yourself. 640K of 1.0M context used. You will be reminded again after another 200K of growth.

You do not have to compact after this message, compact only if there is a large chunk of finished work in the way: exploration that led nowhere, tool output you have already used, a phase whose result is recorded. If nothing qualifies, carry on with the work.

You can choose to compact at any time you seem suitable. To compact, call `compact()` with no arguments to list the spans and the summary writing instructions, then choose the span to compact.
</pi-context-fold>
```

**160 tokens**, measured, up from 43. The extra 117 buy the decision itself: without them the
model cannot tell whether compacting is worth a 5.4K menu call, and the cheapest way to find out
is to make the call. It does **not** start a turn of its own — the model reads it at the start
of its next turn either way, and waking the model to tell it that nothing is required spends a
model call on nothing.

*"You do not have to compact after this message"* is the one sentence that has to be there. Every
other message this extension sends is something the model must act on, and a report that looks
like those gets acted on too.

The 200K figure is interpolated from the configured `nudgeGrowthTokens`, so the sentence cannot
drift from the number that produces it — including when it is not 200K.

### 7a. The last nudge

A nudge needs 200K of growth to fire, so once the window has less than that left, no second
nudge can arrive before the overflow cut. That one is a warning, and it says so. It is the
only nudge that starts a turn of its own, because there may be no ordinary turn left in which
to act on it.

```
<pi-context-fold>
This is a reminder that you handle the context compaction yourself. 910K of 1.0M context used. This is the last reminder before this session runs out of context.

Compact as soon as possible. Call `compact()` with no arguments to list the spans and the summary writing instructions, then choose the span to compact.
</pi-context-fold>
```

**88 tokens**, measured — shorter than the ordinary nudge, because everything that helps the
model decline is gone. What happens next, in full, is §8.

### 7b. `/compact`, the key we cannot delete

Pi's own `/compact` cannot be removed by an extension and cannot be shadowed by one. So the key
stays and we choose what it does: it cancels Pi's compaction and sends **the ordinary nudge**,
§7 word for word, with a turn of its own.

The ordinary one and not §7a's, deliberately. Pressing the key says *now would be a good time*,
not *this session is about to run out*. The model still decides, and if nothing is finished it
says so and carries on — the same answer it is allowed to give any other nudge.

The number sentence is dropped when Pi does not know the context size, which it does not
immediately after a compaction. Nothing invents a second meter (P4):

```
<pi-context-fold>
This is a reminder that you handle the context compaction yourself. You will be reminded again after another 200K of growth.
…
</pi-context-fold>
```

The prior art shows the cost of getting this wrong: `acp-kernel` ships its 1,179-token
rules in the system prompt **and** again in full inside every nudge.

---

## 8. Overflow note

Written by us as Pi's compaction summary. Replaces the older half of the session. **Only on a
real overflow** — `/compact` is answered with a nudge (§7b) and ordinary pressure is cancelled,
so this text is reached when the window is genuinely full and there is no turn left to ask in.

**No marker of our own.** This string becomes the `summary` field of Pi's compaction entry,
and Pi wraps it on the wire with *"The conversation history before this point was compacted
into the following summary:"* plus `<summary>` tags (`messages.js:7-11`). Adding our own
prefix would double the framing.

> `This session overflowed its context window, so the older half was removed from view
> rather than summarised. Those 1,830 messages (~412K tokens) were written verbatim to
> ~/.pi/agent/context-fold/overflow/01a094-1789192.txt — read or grep that file to retrieve
> any of it — or read the session log at <sessionFile>, which still holds every message.
> Summaries you wrote for compacted spans in that half are reproduced below.`
>
> *(the last sentence only when at least one block was fully cut — otherwise the note ends
> at the file path, because a fixed string would state a falsehood)*
>
> *(then, verbatim, each fully-cut block's own summary)*

**≈ 70 tokens plus the reproduced summaries.** Must say what happened, that it was *not*
summarised (so the model does not trust it as a summary), and where the content is.

An earlier draft ended *"Folded blocks and their files are unaffected"*. That was wrong: the
cut is at the 50% mark, which is exactly where folded content sits, so a block entirely
before the cut loses its anchor in the view. Carrying those blocks' own summaries into this
note is what makes the claim true — and it is the best available recovery, because the
summaries are the model's own words, reproduced mechanically with no second model call.

If the file write failed:

> `This session overflowed its context window, so the older half — 1,830 messages, ~412K
> tokens — was removed from view. Writing it to a file failed (<reason>); the content
> remains in the session log at <sessionFile>.`

---

## 9. Not model-facing

Everything below is written for the person at the TUI. None of it reaches the model, because
Pi carries it in a tool result's `details` or draws it from a renderer, and neither is sent
to the provider. So this half costs no tokens.

The footer status, under the key `pi-context-fold`, which `pi-powerline-footer` can give its
own segment:

```
compacted 312K, 4 blocks
```

A `compact()` call that asked for the menu, and its result. The menu itself is ~5.4K tokens
of ids and guidance, and reading it is the model's job, so you get its size instead:

```
compact
199 entries listed, ~420K compactable.
```

A `compact(...)` call that folded spans, and its result — one row per span, the path left out
because the summary in the view already carries it. The tool row names the spans in the order
they were asked for, before any of them is checked:

```
compact e1–e37, e40–e44
Compacted e1–e37 into b5. 412K → 3.1K, 38 messages replaced.
Compacted e40–e44 into b6. 22K → 0.8K, 9 messages replaced.
```

The nudge, labelled so it is not read as the model's own words. How much is compactable is not
here either: saying it meant building the whole menu on every nudge to count it.

```
[pi-context-fold]

640K of 1.0M context used.
```

The last nudge adds one line, because it is the one you would want to see coming:

```
[pi-context-fold]

910K of 1.0M context used.
Last reminder before the context runs out.
```

---

## Totals

| | Tokens |
|---|---|
| **Every request** (system prompt + one tool schema) | **343** (158 + 185) |
| Per nudge | 160, or 88 for the last one |
| Per menu | ~5,300 (337 of it instruction) |
| Per fold | ~50 result + ~15 permanent prefix |

The original, **measured** rather than estimated: **3,704 tokens of system prompt in every
request**, plus four tool schemas, plus a ref tag on every message in context, plus 1,366
tokens per nudge of which 1,179 repeat the system prompt verbatim.

Ours: **343 tokens per request**, and the 337-token instruction is paid only on the turns
where a fold actually happens.

---

## Open questions

None.
