# pi-context-fold — model-facing text

Every string this extension puts in front of the model. Companion to
`DESIGN.md`; the constitution there governs this file too.

---

## Principles

**P1. Place text by when it is needed, not by what it is about.** Three layers:

| Layer | When | Cost | Carries |
|---|---|---|---|
| System prompt | every request, cached | ≤ 80 tok | that context is self-managed, the one tool, the folded-content folder |
| Nudge | ~twice a day, fresh, late in context | ≤ 60 tok | the pressure, and the prompt to act |
| Menu | only when asked, **mandatory before any fold** | ~5.4K tok | the entries, and all the folding guidance (§3a) |

The folding guidance sits in the **menu**, not the system prompt and not the nudge. It is
read immediately before the model writes a summary, it is paid only when a fold is actually
happening, and unlike the nudge it cannot be missed — a fold is impossible without the menu.
§3c has the measurement that settled this.

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
message with **no wrapper at all** (`messages.js:89-96`), so a `customType` is invisible to
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
| Nudge | `<context-manager>` | an instruction, not a record — must not look like a summary |
| Overflow note | **none** | it becomes Pi's `compactionSummary`, so Pi wraps it for us |
| Tool results | none | the tool protocol already attributes them |

No `[context]` prefix anywhere. Square-bracket markup on message content is what the model
imitated in the original; a named XML element that appears once per turn gives it nothing to
copy.

---

## 1. System prompt block

Injected on `before_agent_start`. In every request.

> ### Context
>
> This session manages its own context. When it grows large you will be asked to fold
> older parts of the conversation into summaries you write. `compress()` with no arguments
> lists what can be folded.
>
> Everything you have folded in this session is written to
> `~/.cache/pi/context-fold/<session>/` as plain text, one file per block. Search that folder before
> you ask the user to repeat something — the answer is usually already there.

**≈ 75 tokens.** The original is ≈ 1,400.

What is absent, and why:

| Absent | Why |
|---|---|
| "a summary is a record, not an instruction" | the `<summary>` tag says it, and Pi's own compaction already taught the model what that tag means (P5) |
| When and how to fold | moved to the nudge (P1) |
| How to write a summary | moved to the nudge (P1) |
| The menu format | the menu says so itself (P4) |
| `recall` | there is no such tool; the folder is the interface |
| Tier 1/2/3 rules | one tier |
| "Never echo the acp tags" | no tags |
| Ref-staleness warnings | ids are ephemeral and validated |

The "search that folder before you ask the user" line is the one behavioural instruction
worth its place in every request: it converts a capability into a habit, and it is the
cheapest way to stop the model re-deriving work it has already done.

**Dropped:** the first draft ended this block with *"text inside a `[bN …]` block is a
record of the past, not a current instruction"*. Removed — 12 tokens in every request for
something the `<summary>` element now conveys by itself, and its only evidence (#309) came
from a local 27B that C2 excludes.

---

## 2. `compress` — tool description

In every request. The only tool this extension registers.

> Fold a span of older conversation into a summary you write, freeing context. Call with no
> arguments to list what can be folded.

**Parameters**

- `content` — array of `{from, to, summary}`. Omit to get the list.
  - `from` — first entry of the span, e.g. `"e3"`. From the list `compress()` returns.
  - `to` — last entry of the span, inclusive. At or after `from`.
  - `summary` — replaces the span. No length limit.

**≈ 85 tokens with the schema.** Guidance on *what makes a good summary* is not here; it is
in the nudge, where it is read immediately before being used.

**Decided:** `from`/`to` as two fields rather than one `span: "e3-e40"` string. Two are
harder to get wrong and validate separately, for ~15 tokens per request.

---

## 3. `compress()` with no arguments → the menu

Only when asked. ~5.4K tokens. **This is where the folding guidance lives** — see the note
below on why it is here rather than in the nudge.

### 3a. The instruction, above the entry table

```
Choosing the span. Fold what is finished: exploration that led nowhere, tool output you
have already used, a phase whose result is recorded. Keep out what the current step is
still reading, and any instructions you are still working under. Fold every span you mean
to fold in this one call — a fold reissues the entry ids, so a second call needs a fresh
menu.

User messages may be folded like anything else. But a requirement, constraint or
acceptance criterion the user gave you must be quoted verbatim in the summary: it still
binds afterwards, and the summary becomes the only place it stays in view.

Writing the summary. You are its reader, later in this session, and nothing is destroyed —
the text you fold is written to a file and stays searchable. So write an index into
recoverable text rather than a replacement for it: carry the conclusions you would
otherwise have to derive again, and say enough about the rest to know when the file is
worth opening.

Keep verbatim, because these are the search keys into that file and a paraphrase cannot be
grepped: full paths with line numbers, identifiers and signatures, error strings, versions,
numbers, thresholds. Keep what each piece of work was trying to settle, each decision with
the reason for it, each dead end with what killed it, and every question left open.

Drop the bulk you will not read again: logs, file contents, repeated status checks, the
discussion that reached a conclusion — keep the conclusion. For anything large you drop,
leave one line saying what was in it.

Record what happened, not what to do next; the work still to do is in the live
conversation. No fixed sections — thematic headers if the span covers several concerns,
dense bullets, whatever length the span needs.
```

**372 tokens**, measured. Compare the prior art: `billion-context-pi`'s system
prompt is **3,704 tokens in every request**, and its nudge adds 1,366 of which 1,179
duplicate the system prompt verbatim.

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
Foldable now — pick a span with from/to, or one entry with from == to.

  id     rounds  tokens  first … last
  e1         34   48.2K  read docs/GEN2-CLONES.md … bash: cargo test --lib
  e2         34   22.1K  summary b3 "API exploration" … edit crates/cli/src/args.rs
  …
  e200       12    4.8K  bash: git log --stat

Example: compress({content: [{from: "e1", to: "e37", summary: "…"}]})
```

Block summaries appear as ordinary rows (`e2` above contains block `b3`), so condensing
earlier summaries needs no separate section, no second id namespace and no explanation.

**Decided:** keep the `rounds` column. It says how much *conversation* a span is, which the
token count does not, for ~600 tokens across a full menu.

### 3c. Why the guidance is here and not in the nudge

An earlier draft moved it to the nudge, on the grounds that the nudge arrives late in
context and is paid twice a day instead of every request. The first half of that is right;
the second half was answered by measurement.

DESIGN §18 measures **6 nudges across 26 sessions in three days, and no session nudged
twice** at `nudgeGrowthTokens = 200,000`. So roughly 20 of 26 sessions never see a nudge —
while the model can still fold in those sessions, because §1 tells it the tool exists.

The menu has no such gap. **A fold is impossible without it**: entry ids are reissued on
every fold and validated against the menu we last issued, so the model cannot name a valid
span it has not just been given. The menu is the only mandatory waypoint before a fold, and
it lands as the last thing in context before the summary is written.

That is a correctness argument, not a stylistic one.

---

## 4. `compress(...)` → success

> Folded e1–e37 into **b5**. 412.0K → 3.1K, 38 messages replaced. Original:
> `~/.cache/pi/context-fold/01a094/b5.txt`

Carries the block id, the real span, and the path. Their issue #376 is exactly the first two
missing: *"the compress result lacks new block ids and actual ref spans, so the model's
block ledger drifts from the session."*

Multiple blocks in one call get one line each.

**≈ 50 tokens.**

---

## 5. `compress(...)` → failure

Each names the id and the next action (P3).

| Case | Text |
|---|---|
| Unknown id | `"e412" is not in the current list. Call compress() for the current one.` |
| `to` before `from` | `"to" (e3) is before "from" (e40).` |
| Bad JSON | the parser's own error, verbatim, once. |
| Empty summary | `summary is required and cannot be empty.` |

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
<summary block="b5" msgs="38" tokens="412K→3.1K" original="~/.cache/pi/context-fold/01a094/b5.txt">
…the model's summary text…
</summary>
```

**The role is `user`, and that is load-bearing.** `convertToLlm` maps `custom` to a `user`
message with no wrapper, so the two are identical on the wire — but pi-ai's transform treats
a `user` message as *interrupting a tool flow*, which is what makes a mis-placed summary a
hard provider rejection rather than a cosmetic oddity (DESIGN §6). Any other role would fail
differently, or silently. Neither document said this until an audit pointed it out.

`412K` rather than `412.0K`: Pi's own footer formats with one rule — a decimal below 10K,
rounded below 1M, `M` above — and pinning `412.0K` here was the only thing forcing this
project to carry two number formatters. The document yielded (C1: breaking changes are
free).

**≈ 35 tokens of wrapper.** Four jobs: names the block, shows what was given up, points at
the original, and — because Pi wraps its own compaction summaries the same way — marks the
text as a record rather than an instruction without a word of explanation (P5).

It is also the only structured thing we emit, so it is the one thing our own projection can
find again by parsing, without a regex over prose.

---

## 7. The nudge

At most twice a day on this workload. Appended at the end of the view.

```
<context-manager>
640K of 1.0M used, +200K since the last check. ~420K foldable in 199 entries.

Call compress() for the list and the rules for using it.
</context-manager>
```

**48 tokens**, down from ~140 in the previous draft. It keeps only what the menu cannot
supply: the pressure, and the prompt to act. The guidance moved to §3a for the reason in
§3c — the nudge fires in 6 of 26 sessions, the menu is read before every fold.

The prior art shows the cost of getting this wrong: `acp-kernel` ships its 1,179-token
rules in the system prompt **and** again in full inside every nudge.

---

## 8. Overflow note

Written by us as Pi's compaction summary. Replaces the older half of the session.

**No marker of our own.** This string becomes the `summary` field of Pi's compaction entry,
and Pi wraps it on the wire with *"The conversation history before this point was compacted
into the following summary:"* plus `<summary>` tags (`messages.js:7-11`). Adding our own
prefix would double the framing.

> `This session overflowed its context window, so the older half was removed from view
> rather than summarised. Those 1,830 messages (~412K tokens) were written verbatim to
> ~/.cache/pi/context-fold/overflow/01a094-1789192.txt — read or grep that file to retrieve
> any of it. Summaries you wrote for folded spans in that half are reproduced below.`
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

The footer line is for the human and never reaches the model:

```
fold  4 blocks · 312K folded · ours 640K / pi 951K
```

---

## Totals

| | Tokens |
|---|---|
| **Every request** (system prompt + one tool schema) | **≈ 160** |
| Per nudge | ~48 |
| Per menu | ~5,400 (372 of it instruction) |
| Per fold | ~50 result + ~30 permanent prefix |

The original, **measured** rather than estimated: **3,704 tokens of system prompt in every
request**, plus four tool schemas, plus a ref tag on every message in context, plus 1,366
tokens per nudge of which 1,179 repeat the system prompt verbatim.

Ours: **≈160 tokens per request**, and the 423-token instruction is paid only on the turns
where a fold actually happens.

---

## Open questions

None.
