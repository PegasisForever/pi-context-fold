# pi-context-fold — design

Clean-room rewrite. Personal tool, single user, published as is: no support, and no promise
that anything here stays the same (C1).
Unrelated to any other project.
Host: Pi `@earendil-works/pi-coding-agent` 0.85.1.

Every Pi seam named below was read in the installed source; file:line references are to
`~/.nvm/versions/node/v26.4.0/lib/node_modules/@earendil-works/pi-coding-agent/dist`.

---

## Constitution

**This section outranks everything below it.** The rest of this document is a snapshot of
reasoning, not a contract. If a decision below contradicts a principle here, the decision
is wrong: change the decision and this document with it. Never implement something you believe is
wrong merely because it is written down. A design document that is followed against its
own principles is how the thing we are replacing got to 9,950 lines.

**C1. This is a personal tool.** One user, one fleet, no public release. No backwards
compatibility, no migration path, no deprecation cycle. Breaking changes are free. Delete
rather than deprecate.

**C2. SOTA long-context models only.** Assume the model follows instructions, writes good
summaries, emits valid arguments, and can read a menu. Do not build guards for models that
cannot. Roughly half the original's bug history is damage control for small and quantised
models; none of it belongs here.

**C3. Do not overengineer.** The fewest moving parts that work. No abstraction with one
implementation. No configuration key without a reason to turn it. No layer added "in
case". When in doubt, leave it out — adding later is cheap, removing later is not.

**C4. Prefer deleting to adding.** The original failed by accretion: every incident added
a guard, and no guard was ever removed. When a new failure appears, the first question is
which existing mechanism should go, not which new one to add.

**C5. The host is the source of truth.** If Pi already knows it — token usage, entry ids,
skill paths, the context window, that an overflow happened — read it. Never re-derive,
re-estimate, or re-detect. Most of the original's complexity is a second, worse copy of
something Pi already had.

**C6. Never mutate history.** Message bytes, once written, are final. Every transformation
happens in the view. The session log is the record, so anything hidden stays recoverable.

**C7. Fail loudly.** A visible stop beats a quiet corruption. Log the reason with enough
detail to diagnose it days later. Never swallow an error to keep going.

**C8. When the model gets something wrong, fix the information, not the model.** The first
question is what we failed to tell it — not what guard to add.

**C9. Measure before tuning.** Numbers come from the log and from real sessions, not from
intuition. If it cannot be measured, it does not get a knob.

**C10. No fallback without evidence.** Do not write a second code path for a case you have
not seen happen. No `try`/`catch` that quietly substitutes a different answer, no "if the
host does not do X, do Y", no self-healing, no learned values, no compatibility shim, no
tolerance constant pulled out of the air. An unproven fallback is untested code that will
one day run instead of the correct path, and you will not know it did. If you think a case
is possible, prove it occurs before handling it. If you cannot prove it, let it fail
loudly (C7) and build the handling when the log shows you the real shape of it.

---

## 0. Status

Audited 2026-09-12 by three independent reviews: constitution compliance, mechanism
feasibility against Pi 0.85.1, and adversarial failure construction. 19 constitution
violations, 5 mechanism blockers and 3 measured falsifications were applied below.
Everything in §17 is what those reviews changed.

**Settled.**

| | Decision |
|---|---|
| 1 | Overflow recovery is mechanical: the older 50% is written to a file and replaced by a note, supplied to Pi at `session_before_compact`. No model call (§8). |
| 2 | Decisions happen at `turn_end` — one iteration of Pi's inner loop, not one user prompt (§2 D3). |
| 3 | The model addresses **menu entries** (`e1…e200`, ephemeral) and **blocks**. Rounds are internal only (§5). |
| 4 | The menu is **on demand** — `compress()` with no arguments returns it (§6, §8). |
| 5 | After a fold, the compress tool-call block and its result are removed; the block id is prefixed on the summary (§6). |
| 6 | *(superseded by 27 — skills get no special handling; see §9.)* |
| 7 | No "recent tokens" reserve. H1 is the only recency rule (§4). |
| 8 | Nothing is protected by tool name (§4 P3). |
| 9 | **One tool, `compress`.** No `recall`: folded originals are written to a file at fold time and the model reads or greps them (§6). |
| 10 | One tier. No promotion, no generations. |
| 11 | No on/off switch. To disable it, uninstall it. |
| 12 | No `contextLimit` key. Pi already overrides a window per model in `~/.pi/agent/models.json`. |
| 13 | No `protectedTools` and no `protectSkills` keys. Nothing is protected at all (27). |
| 14 | The nudge trigger is **growth**: re-nudge every `NUDGE_GROWTH_TOKENS`, 200,000 (§8). |
| 15 | No benefit floor. |
| 16 | No environment variables. |
| 17 | Per-project `<project>/.pi/context-fold.json` overrides `~/.pi/agent/context-fold.json`. |
| 18 | No summary length limit. |
| 19 | **The view is built from session entries, not from `event.messages`** (§3). Forced by a measured fact, see §17, row 19.1. |
| 20 | *(superseded by 21 — there is no meter of our own; `ctx.getContextUsage()` is the number.)* |
| 21 | **No meter of our own.** `ctx.getContextUsage()` is the context number (§7). |
| 22 | The newest **failed** compress pair stays visible (§6). |
| 23 | No `/acp` command. One `setStatus` line in Pi's footer (§6). |
| 24 | *(superseded by 27 — there is no protected content.)* |
| 25 | The menu partitions by round count and treats block summaries as ordinary entries (§5). |
| 27 | **Nothing is protected.** No mechanism exempts any message from folding; the instruction returned with the menu carries the judgement instead (§4b, §9). |
| 28 | The `context` handler **never throws**. A record it cannot use is skipped and logged; every other fold still applies (§3). |
| 29 | **Permanent, not provisional (§17, row 19.58):** `liveBlocks` casts a record rather than validating it. The only writer is our own code in one version and C1 forbids back-compatibility, so a validator has no evidence (C10). A malformed record would crash the handler and send the unfolded history; the protection is social until step 5. |
| 26 | System-authored text follows Pi's own markup convention: `<summary …>` for folds, `<pi-context-fold>` for the nudge, nothing for the overflow note (Pi wraps it). No `[context]` prefix anywhere — bracket markup on message content is what the model imitated in the original. |

**Open.** Nothing.

**Where changes are recorded.** The Constitution requires a decision that contradicts a
principle to be recorded here. In practice the table above carries the *current* decisions
and **§17 carries every change with the evidence that forced it** — including changes to
this document made during the build. §17 is the audit trail; this table is the state.

**Progress** (§16 build order). All five steps are landed. 914 source lines, 178 test lines,
4 tests. What has and has not been verified is §19.

The audit trail is §17; every row there is a change some review forced, with the evidence.

---

## 1. Goal

Let one Pi session run for weeks without running out of context, while keeping the
session coherent and keeping the cost of compression below the cost of not compressing.

Non-goals: sub-agents, self-update, other hosts, multi-tier summaries, publication.

---

## 2. The five decisions that shape everything

**D1. Nothing is ever written into message text.**
No ref tags. Historical message bytes never change after they are written. The model
addresses rounds through a menu it asks for (§5).

**D2. The context handler is a pure projection.**
No decisions, no I/O, no counters, no locks. Same inputs, same output.

**D3. All decisions happen at `turn_end`** — after each assistant message and its tool
results (`agent-loop.ts:244`). That is one iteration of Pi's inner loop, not one user
prompt, so a marathon agentic run still gets decision points. Measured on a real session:
median 10 iterations per prompt, maximum 73.

**D4. The session log is the only durable record.**
Compression records are `custom` session entries written with `ExtensionAPI.appendEntry`
(`agent-session.js:2030` → `session-manager.js:835`). Pi returns them from
`buildContextEntries()` but projects them to zero messages (`session-manager.js:166`), so
they are invisible to the model. They survive fork, resume and export. No sidecar file,
no parent inheritance, no log-replay recovery.

**D5. We own compaction, including the overflow path.**
Pi's own compaction summarises the **raw** history (`compaction/compaction.js:497`), which
on a compressed session would overflow on the summarisation call itself. So Pi's
summariser must never run (§8).

---

## 3. Addressing — building the view

**We ignore `event.messages` entirely and build the outgoing array from session entries.**

This reverses the first draft, which mapped `event.messages` by position. That was
falsified on this machine (§17.1): `pi-goal-x` registers two `context` handlers that
*delete* messages from the array, and Pi chains handlers so each sees the previous one's
output (`extensions/runner.js:791`). Any positional correspondence is gone before we are
called.

```ts
const entries  = ctx.sessionManager.buildContextEntries();     // what Pi would send
const view     = entries.flatMap(sessionEntryToContextMessages); // Pi's own projector
// every message in `view` has a known entry, because we just projected it
```

Both functions are exported from the package root, so the projection cannot drift from
Pi's.

What this keeps from the original's approach, and what it drops: the original also rebuilds
from the log, and for the same reason — its README says so plainly. But it then flattens
every message to `{id, role, text}`, loses the structure, and spends ~600 lines
reconstructing it (`coreOutToAgentMessages`, `#callId` splitting, `syncToolCallArgs`,
`matchesStoredText`). We never flatten. `sessionEntryToContextMessages` hands back the real
message objects; we drop some, edit one block inside others, and return the array.

**Two different reads, two different purposes** (§17.2):

| Need | Source | Why |
|---|---|---|
| the outgoing view | `buildContextEntries()` | it is exactly what Pi would send |
| block records, round ordinals | `getBranch()` | entries before a compaction cut are dropped from `buildContextEntries()`, including our own `custom` records |

**Known consequence.** Rebuilding overrides any `context` handler that ran before us. On
this install that is `pi-goal-x`, which strips its own audit markers so they cannot land
between a tool call and its result. We therefore apply the same structural rule ourselves:
**never emit a non-tool message between a tool call and its result.** That is a correctness
rule we need regardless (H3), not a coupling to another extension.

---

## 4. What the model may and may not fold

### 4a. Hard rules — correctness

| | Rule | Why |
|---|---|---|
| H1 | The **in-flight round** and the one before it are never offered | You cannot fold the message you are answering. |
| H2 | A tool call and its result fold **together**, never apart | An orphaned tool call makes the provider reject the request. |
| H3 | The system prompt | Pi owns it. |

The first draft had a fourth rule — "entries already covered by an active block". It is
gone, because it was a restatement of how the menu is built (§17, row 19.31). The menu is
partitioned from **the view**, and folded content is not in the view, so there is nothing
to exclude. A rule that cannot be violated is not a rule.

### 4b. Nothing is protected

**There is no protected-content mechanism.** No user message, no skill load, no tool output
is mechanically exempt from folding. The model may fold any span the menu offers, and the
projection has no notion of content that survives inside a fold.

What replaced them is **information, not enforcement** (C8). The instruction returned with
the menu (MODEL-FACING-TEXT.md §3a) names two things to keep out of a span — whatever the current step
is reading, and a skill's instructions while still working under them — and one thing to
**carry forward verbatim**: a standing requirement, acceptance criterion or constraint the
user gave.

That last distinction matters and the first draft of this section got it wrong. "Do not fold
the user's standing requirements" is not executable: an entry spans ~34 rounds and there is
no exclusion mechanism, so the model cannot avoid a requirement it finds mid-span. Quoting
it into the summary is executable — and it is what this section's own justification already
assumed.

Three things make this safe rather than reckless:

- **Nothing is destroyed.** Every fold writes its original to
  `~/.pi/agent/context-fold/<session>/<blockId>.txt`, and the folder is greppable.
- **A folded skill is trivially re-readable.** Pi puts each skill's `<location>` in the
  system prompt (`skills.js:289-295`), so the model can re-read the file it folded.
- **A summary the model wrote itself** is far more likely to carry its own standing
  requirements than a mechanism is to guess which messages held them.

What this deletes: `isProtected`, the H2 closure over protected items, the "kept in place"
line in the fold result, the protected line in the menu, the skill-path matching, the
`before_agent_start` skill cache, and `skills.ts` in its entirety.

### 4c. Live blocks

A block is **live** when no later block has consumed it. That is derived from the records,
not a stored flag: when the model folds a span that includes an earlier block's summary,
the new block's record covers that block too, and the old one stops being live.

There is no "active" flag and no deactivation step. With one tier and no promotion, "live"
is the only state that matters, and it is a function of the records.

### 4d. No other limits

No minimum span size. No summary length limit. No tool protected by name.

---

## 5. The menu — how the model names what to fold

The model names **menu entries**, and nothing else. It never sees a message id, a round id,
or a block id used as an address.

A **round** is one iteration of Pi's inner loop — one assistant message plus the tool
results answering its tool calls. It is an internal boundary unit: an entry never splits a
round, because splitting one orphans a tool call (H2).

A **menu entry** is a contiguous span of the view, with an ephemeral id `e1…e200`, valid
only against the menu we last issued. Ids are regenerated with every menu, so nothing needs
to stay stable across a fold, a compaction, a fork or a restart.

**Compaction entries are not offered.** Pi's compaction summary is the pointer to our
overflow file (§8); folding it wraps a lossy summary around a lossy summary and loses the
pointer. That is the whole reason.

**Block summaries are ordinary entries.** A block's summary is a message in the view, so
the partition treats it like any other content. Folding a span that happens to include one
produces a new block covering it — which is exactly the "condense my earlier summaries"
operation, with no separate concept, no second id namespace, and no line in the system
prompt (§17, row 19.33).

The menu as the model reads it is transcribed in `docs/MODEL-FACING-TEXT.md` §3b.

### How the partition works

**Nothing is hidden.** The menu is a *partition* of the whole foldable view into at most
200 contiguous entries. Every foldable round sits in exactly one entry.

This works because **coarseness only costs precision at the two edges of a fold.** A fold
names a `from` and a `to`; everything between is included however the middle is divided.

**Divide evenly by round count.** `chunk = ceil(foldableRounds / 200)`, then emit every
`chunk` rounds. One line. Note what the ceiling does: the count lands between 100 and 200,
not at 200 — 224 foldable rounds give 112 entries, 401 give 134. "At most 200" is the
guarantee; it is not a target.

---

## 6. Tools

**One tool: `compress`.** There is no `recall` and no slash command.

### `compress`

**No arguments → the menu.** With arguments → fold.

```
compress({ from: "e3", to: "e40", summary: "…" })
```

`from`/`to` are inclusive and must both be in the menu we last issued. **One span per
call.** The array an earlier draft took is gone: the model never batched in any live run,
and the array produced overlapping-span content loss, an order-dependent check and a
half-appliable write loop — all three unrepresentable with a single span (§17, row 19.59).

Arguments arrive already parsed and schema-checked by Pi. No lenient parsing, no brace repair,
no stringified-array handling — that machinery exists in the original for a Qwen model in
non-strict tool mode and a local quantised 27B (#253, #250), which C2 excludes. A parse
failure returns the parser's own error, once, verbatim (C7).

An unknown id is an error naming it. There is no other rejection: nothing in a span is
exempt from folding (§4b).

### The original content goes to a file, at fold time

This replaces the `recall` tool entirely (§17, row 19.35).

When a fold lands, we already hold the content being folded. Write it to
`~/.pi/agent/context-fold/<sessionId>/<blockId>.txt` — plain text, one section per message — and end
the summary message with the path.

The model then has two capabilities it did not have with a fetch tool:

- **Read one block's original**: `read` on the path. No tool call to learn, no schema in
  every request.
- **Search everything ever folded in this session**: `grep` the directory. A fetch-only
  tool could never do this, and it is the operation the model actually wants — "where did I
  see that error string" spans blocks.

So the tool surface shrinks *and* the capability grows. `recall.ts` and its ~35 tokens of
schema in every request are gone.

Consequence to accept: a long session writes its folded content to disk, and the cache
directory grows. This machine is a disposable sandbox. If the directory is cleared the
pointers dangle, but the content is still in the session `.jsonl`.

### History rewriting

After a **successful** fold:

- **A block's covered set is the transitive closure of the call↔result pairing.** A covered
  result takes its call, that call's assistant message, **and that message's other
  results**. One extra hop, bounded — a result belongs to exactly one assistant. Coverage
  is therefore always round-aligned, and the summary lands at the block's first covered
  entry, unconditionally.

  The third hop is the one an earlier version missed, and its absence was reachable (§17,
  rows 19.48, 19.51). The closure ran on tool-call ids rather than on coverage: a covered
  result retired its call, but the assistant message that made the call stayed in the view
  with its *sibling* call intact, so the summary landed between that surviving call and its
  result. The consequence is harder than "the model is misinformed", and it was measured on
  a live run: pi-ai's repair injects a synthetic result for the pending call, the real
  result then follows, and the provider rejects the request outright —

  > HTTP 400 `Duplicate function_call_output for call_id '…'. Each function_call must have
  > exactly one matching function_call_output`

  The turn hard-fails and Pi retries it four times. With the closure complete, the same
  session sends `user, <summary>, assistant, user` and the model answers a codeword that
  exists only inside the summary.

  Two measurements make round alignment sufficient on its own. With the one-hop closure,
  **637 of 637** answered multi-call rounds across 19 of the 23 recorded sessions straddle
  when only the first result's entry is covered. And the recorded corpus contains **zero**
  genuine straddles — Pi never interleaves two rounds — so once coverage is round-aligned
  the invariant holds with no guard.

  Note what this is not: no `Round` type, no enumeration, no `View.rounds`. Round alignment
  falls out of closing a relation that was already there, so C3's deletion of rounds from
  step 1 stands.
- **Remove the `compress` tool-call block and its result.** Not the whole assistant
  message — 8.6% of assistant messages carry two or more tool calls, so dropping the
  message orphans a sibling's result, and pi-ai repairs orphan *calls* but not orphan
  *results* (`transform-messages.js:125-184`).
- **Strip thinking blocks from the surviving assistant message.** The summary lives in the
  tool-call arguments and the thinking rides along on every request forever; the original
  measured its own version of this as **83.5% of the irreducible residual** (#336, #340).
  69% of this user's assistant messages carry signed thinking; signatures are per-block and
  never chained, so removing them is safe.
- **Also remove the menu call and its ~5K result**, same rules.
- The summary message is wrapped in `<summary block="b5" msgs="38" tokens="412K→3.1K"
  original="…/b5.txt">`. That follows Pi's own convention for system-authored context —
  it wraps its compaction and branch summaries the same way (`messages.js:7-17`) — so the
  model needs no sentence explaining that the text is a record rather than an instruction.
  It is also the one structured thing we emit, so our own projection can find it again by
  parsing rather than by a regex over prose.

### Failures stay visible, untouched

**A failed compress call and its result are left exactly as they are.** No collapsing, no
one-line replacement, no bookkeeping.

acp-kernel ships `KEEP_LAST_ORPHANED = 2` with the comment: *"failures must stay observable
or a deterministic model re-issues the same no-op compress forever, pinned at a fixed point
(3,849 identical calls over 5h13m under KEEP_LAST_ORPHANED=0)"*. So failures must be
visible. The first draft then added a rule to collapse *older* failures to one line, which
is machinery for a case that should barely exist: the two causes of mass failure in the
original were stale refs and weak models, and both are excluded here (§17, row 19.36).

If the log ever shows failed calls accumulating, we add the collapse then (C10).

### Two texts — one for the model, one for you

Every tool result and every injected message carries two texts. The model's is `content`,
which is sent to the provider and costs tokens. Yours is `details`, which Pi hands to the
renderer and never sends, so it costs nothing.

They are not the same text, and they must not be. The menu is ~5.4K tokens of entry ids and
folding guidance written for a model that is about to choose a span; printing it in the
terminal fills the screen with something you have no use for. So `compress()` with no
arguments shows you one line — how many entries, how much is foldable — and a fold shows you
what it replaced and by how much, without the file path the summary in the view already
carries. `docs/MODEL-FACING-TEXT.md` §9 holds both, side by side, so the split can be
audited without reading the code.

`renderCall` and `renderResult` are what make this possible: a tool with neither gets Pi's
fallback rendering, which prints the model's own text.

### Status — one line, for the human

`ctx.ui.setStatus(key, text)` gives us a slot in Pi's own footer (`types.d.ts:80`). **The
key is `pi-context-fold`**, the extension's own name, so `pi-powerline-footer` can lift it
into a segment of its own with a `customItems` entry naming that key:

```
folded 312K, 4 blocks
```

**The line carries only what Pi cannot know** — how many blocks exist and how much has been
folded. It shows no context number at all.

The `?` case goes with the number it guarded.

Note on spacing: Pi collapses runs of spaces (`footer.js`), powerline does not. Single
spaces, so the line is the same under both.

---

## 7. Token accounting

```ts
const usage = ctx.getContextUsage();          // Pi's own number
const predicted = usage?.tokens ?? undefined; // null right after a compaction
```

That is the whole meter. **We do not compute a context size.**

- It equalled `ctx.getContextUsage().tokens` on **23 of 23** recorded sessions. Of course it
  did: Pi's number is the same anchor and the same estimator over the same entry list
  (`agent-session.js:2741` → `compaction.js`).
- Where the two differed, **ours was the wrong one.** Our anchor could sit before a
  compaction cut, whose kept assistant messages still carry pre-compaction usage: measured
  518,355 against a true ~45K, while Pi honestly reported "unknown". Pi guards this
  (`agent-session.js:2716-2739`); we had reinvented it without the guard.
- It cost 184 lines of source and test to add one bug.

C5 is the principle and this is the clearest case of it on the project: **if Pi knows it,
read it.** The only thing the meter contributed that Pi does not hand over was an error.

`tokens` is `null` right after a compaction, before the next provider reply. That is Pi
being honest, and we inherit the honesty: no nudge that round (§8). It is `undefined` when
there is no model or no known window.

**No output headroom.** `limit = contextWindow − maxTokens` had no reader: the nudge is
growth-based, not a fraction of the limit, so nothing in the design ever compares against a
limit. Deleted with the rest (C3).

---

## 8. Pressure and the emergency path

### Normal pressure — at `turn_end`

Nudge once `predicted` has grown by `NUDGE_GROWTH_TOKENS` since the last nudge — growth, not
a fraction of the limit.

```
nudge when  predicted − baseline ≥ NUDGE_GROWTH_TOKENS
```

No clamp on the step. The first draft capped it at 25% of the window for a 128K-window
model, which C2 excludes and no log shows.

Baseline handling — three rules, and the third is the one that was wrong:

- **session start → `baseline = 0`**, not the current number. An earlier version anchored on
  the current context, which is correct for a new session and wrong for a resumed one:
  resuming an 800K session set the baseline to 800K, so the nudge needed 1.0M on a 1M window
  and could never fire — issue #269 through the resume door, in a project whose whole goal is
  a session that runs for weeks. Starting at 0 nudges a large resumed session on its first
  turn, which is the right answer, and costs nothing on a fresh one. This deletes the
  `session_start` special case rather than adding a fourth rule for resume (§17, row 19.56).
- on a nudge → `baseline = predicted`
- **on a fold → `baseline = predicted` only if `predicted` actually fell.**

The first draft re-anchored on *any* successful fold. With no benefit floor, a fold that
reclaims 712 tokens — the smallest real one in the log — re-anchors the baseline at 899K
and the next nudge then needs 1.1M. The session goes silent until overflow: issue #269
reintroduced, by the very line meant to prevent it (§17.9).

**The menu result is removed from the view on the round after it is served**, whether or not
a fold followed. Otherwise a dead 5K rides every later request for the rest of the session —
that is the reason, and it is the whole reason.

There is no benefit floor. The model decides whether a fold is worth making; we only decide
when to ask.

**The nudge is 147 tokens, and it is a report, not an order.** It states the pressure and
hands the decision back: fold if something in the way is finished, otherwise carry on. That
is the same rule as the paragraph above — the model decides whether a fold is worth making —
applied to the text instead of only to the code. A nudge that demands a fold gets one whether
or not anything is finished, and a summary written over live work costs more than it saves.

**What the nudge carries is what the decision needs**: what qualifies as foldable, that
nothing is destroyed, and what a fold costs. Those were in the menu until now, which put them
behind a 5.4K tool call the model had to pay before it could tell whether it wanted to make
it. What stays in the menu is what the *next* decision needs — which span, and what the
summary must contain (§17, row 19.67). Neither text is duplicated; exact text and the cost of
the split are in `docs/MODEL-FACING-TEXT.md` §3c and §7.

Cadence: at most one nudge per round, and none in the round straight after a fold. Keyed to
the round, never to the user prompt.

**The last nudge is different.** A nudge needs `NUDGE_GROWTH_TOKENS` of growth to fire, so once
`contextWindow − predicted` falls below that, no second nudge can arrive before the overflow
cut. That one says so and asks for the fold. It is a fact about the arithmetic, not a second
threshold to tune.

**Only the last nudge starts a turn of its own**, with `deliverAs: "followUp"` and
`triggerTurn: true`; an ordinary nudge is queued and read at the start of the next turn. The
first version woke the model on every nudge, on the grounds that a queued nudge leaves the
fold undone until the user happens to type. That argument holds for a message the model must
act on and no longer holds for one it may ignore: waking it to say that nothing is required
spends a model call on nothing. pi-background wakes the model for a finished background job
and still should — the user is waiting on that result. Nobody is waiting on this one.

### Overflow — `session_before_compact`

Pi detects the overflow and asks us (`agent-session.js:1665`) with
`reason: "manual" | "threshold" | "overflow"` and `willRetry`, and accepts our own result:

```ts
interface CompactionResult { summary: string; firstKeptEntryId: string;
                             tokensBefore: number; estimatedTokensAfter?: number }
```

- `reason: "threshold"` → `{cancel: true}`. We manage ordinary pressure.
- `reason: "overflow"` or `"manual"` → supply our own. Never cancel.

**No model call. The recovery is mechanical:**

1. Cut at the **earliest round boundary that frees at least half** the view's tokens, and
   when no boundary frees half, **at the last boundary** — keeping only the newest round,
   the most relief available. Never inside a round: that keeps tool results whose calls were
   removed, the direction pi-ai does not repair. The fallback matters: an earlier version
   threw when no boundary freed half, the handler caught it and cancelled, and Pi turns a
   cancelled *automatic* compaction into a turn that vanishes with nothing printed
   (`agent-session.ts:2284-2300`, `:1141`). That case is reachable — one live round held 8
   of 9 messages (§17, row 19.60). The cut point comes from
   `buildContextEntries()`, which is a subset of the branch, so an id that is not on the branch
   is unrepresentable and nothing validates it (§17, row 19.66).

   The cut **does** orphan blocks in the older half, deliberately. Each fully-cut block's
   own summary is reproduced verbatim in the note, which is what MODEL-FACING-TEXT §8 specified all
   along and what makes the recovery coherent without a model call.

Pi writes the compaction entry and, with `willRetry`, re-runs the turn.

That is the entire path. There is no summarisation call, so there is no timeout, no
rate-limit case, no "what if the summary is useless", and no fallback for any of them. The
content is not lost — it is on disk and still in the session `.jsonl` — and folded blocks
keep the summaries the model wrote for them (§17, row 19.29).

**This handler must still never throw.** The runner swallows handler errors
(`runner.js:623-652`) and Pi then runs its *default* compaction, which summarises the raw
path entries — exactly the overflow D5 exists to prevent. The only thing that can fail now
is the file write, so: if it fails, still return the compaction with a note saying the dump
failed. The content remains in the session log either way. This is a fallback, and C10
permits it — the failure mode was reproduced and Pi's own source ships the same guard.

Pi allows exactly one overflow recovery attempt — `_overflowRecoveryAttempted` is set
*before* our handler runs (`agent-session.js:1690`).

**Two gaps we do not handle** (C10; both unobserved, both logged if they occur):
`prepareCompaction` returning `undefined` skips the hook entirely (`agent-session.js:1751`),
and overflow detection requires the same model, so the turn after a `/model` switch gets no
event (`:1646`). This user has 55 model changes on disk across windows of 1M, 872K and 272K.

`before_provider_request` is **not** available as an escape hatch on this install:
`pi-background-tasks` registers a replacement Anthropic provider that throws if the payload
is modified.

---

## 9. Skills

**No special handling.** Pi lists each skill's name, description and path in the system
prompt (`skills.js:275`); the body arrives as an ordinary `read` tool result and is folded
like anything else.

If the model folds a skill it is still working under, two things recover it: the original
text is in the block's file, and the skill's path is in the system prompt, so re-reading is
one `read` call. The instruction returned with the menu tells it not to fold instructions
still in force (§4b).

This is the whole section. The first draft had path matching against Pi's skill registry, a
`before_agent_start` cache, and de-duplication of repeated loads — about 90 lines for a
guarantee the instruction gives for free.

---

## 10. Summary hygiene

**None.** `sanitize.ts` is deleted.

One measurement survives, in `compress.ts`, with no decision attached: if a summary is not
smaller than the content it replaces, log it. The fold still happens.

---

## 11. Module layout

| File | Purpose | Est. lines |
|---|---|---|
| `index.ts` | event wiring, tool registration | 120 |
| `view.ts` | build the view from entries, round boundaries | 100 |
| `menu.ts` | even-count partition, rendering | 80 |
| `compress.ts` | the one tool | 140 |
| `project.ts` | fold projection, block edit, pair removal | 170 |
| `dump.ts` | write folded originals to the session cache dir | 50 |
| `emergency.ts` | `session_before_compact`, mechanical dump | 60 |
| `state.ts` | block records via `appendEntry`, read from `getBranch()` | 80 |
| `status.ts` | `setStatus` line | 20 |
| `types.ts` | shared types (absent from the first estimate) | 32 |
| `shown.ts` | the TUI components both readers' halves are drawn with | 41 |
| `log.ts` | one JSON line writer | 13 |
| **Total** | **actual 914**, against a first estimate of ~830. | |

Against ~9,950 lines of source in the original.

---

## 12. The test suite

**Four tests, 178 lines.** They build their own fixtures and depend on nothing outside the
repository: block records read back from the branch and absorbed correctly, the status line,
the two model-facing strings §4 and §6 read out of `docs/MODEL-FACING-TEXT.md` rather than
copied, and the one token format.

**There used to be forty-four.** The other forty replayed a corpus of 25 recorded session
`.jsonl` files from one machine, by absolute path. Everything in §19's *Verified* column was
measured by those tests, once, against that corpus — and it is the evidence, not the tests,
that mattered. The corpus is not in this repository and is not reproducible here, so the
suite reported forty-four tests and ran four. A suite that cannot run is a record, not a
suite (C4). The record is §19; the tests are gone.

What that costs, plainly: the invariants those forty tests checked — that the projection is
byte-identical to Pi's own output, that a tool result is never emitted without its call, that
a fold never orphans a live block — are now argued rather than checked on every change. §19
says which is which.

---

## 13. No config

There is no configuration file and no configuration key. The three that existed —
`nudgeGrowthTokens`, `logFile`, `debug` — were never set by anybody: no file has ever been
written on the one machine this runs on, and the only thing that ever changed `logFile` was the
test suite, which is circular. C3 forbids a key without a reason to turn it, and C9 says a
number nobody can measure does not get a knob. They are constants in the source now.

Deleting the loader deleted the failure with it. A config read happens at `session_start`, pi
catches a throw from a handler and carries on, and tool registration used to sit behind that
read — so one mistyped key left the session with **no `compress` tool at all**, for its whole
life, while the system prompt went on saying the tool existed. Reproduced. Nothing this
extension needs is decided by a file any more.

---


## 13a. Model-facing text

Every string the model sees — system prompt, tool descriptions and schemas, the menu, all
tool results, the nudge, the fold prefix, the overflow note — is specified in
**`docs/MODEL-FACING-TEXT.md`**, with its token budget and its per-request cost.

Its Totals section carries the per-request cost and the comparison with the original. The
numbers live there, once, so they cannot disagree with themselves.

---

## 14. Explicitly out of scope

Sub-agents. Auto-update. OMP and proxy detection. Multi-tier summaries and block
promotion. A model-facing status tool. Automatic summarisation when the model does not act
— the overflow path in §8 is the only machine-written summary, and only as recovery.
Throttle retry. Degeneration guard. Reasoning drop. Repetition guard. Bash timeouts.
Export command. The pi-subagents settings writer.

---

## 15. Known residual risks

1. **The model may ignore the nudge on a long run.** Issue #269; not model-size related.
   Mitigated, not removed, by §8's overflow path. Cost: one rejected request, then recovery.
2. **Compression costs prefix cache.** Structural — folding rewrites the middle of the
   history. Median retained prefix after a real fold: 33%. There is no way to make it free,
   and with the benefit floor removed some folds will not pay back: 10 of 24 real folds kept
   68–99% of the view and needed 24 to 1,630 turns to break even.
3. **`appendEntry` is less durable than a temp-file-and-rename sidecar.** Pi appends without
   fsync and rewrites the whole file with truncate-then-write in some paths
   (`session-manager.js:711`). Accepted: if the session file is damaged the conversation is
   gone anyway, and co-locating state with data is what stops the two diverging (#299, #322).
4. **The 200K nudge step may be too large for this workload** — measured in §18, chosen anyway.
5. **Rebuilding the view overrides earlier `context` handlers — proven, and accepted.**
   No longer an open question. `pi-goal-x` removes `role:"custom"` messages whose
   `customType` is its audit marker (`goal-session-safety.ts:11`), and those are *persisted*
   by `sendMessage` — so `buildContextEntries()` returns them and **we put back every
   message it deleted, on every request, for the life of the session.**

   Accepted, for two measured reasons. The cost is small: real sessions hold single-digit
   audit entries. And the harm goal-x guards against does not materialise here — its own
   `flush` only sends when `ctx.isIdle()`, so its messages land at turn boundaries, and our
   projection preserves order, so they can never sit between a tool call and its result.

   No fix, per C10: coupling our projection to another extension's `customType` would be a
   mechanism for a problem nobody has had. Revisit if a log shows the token cost mattering.

   *(Original wording, now superseded:)* On this install that is
   `pi-goal-x`. §3 applies its structural rule independently, but this needs a live check.
6. **`prepareCompaction` may skip our hook, and a `/model` switch suppresses overflow
   detection.** Both unobserved, both logged (§8).

---

## 16. Build order

Each step lands **only** the code its own tests exercise. Symbols a later step will need are
written in that later step, not ahead of it (C3: "adding later is cheap, removing later is
not"). Step 1's first pass wrote round enumeration and a block writer for step 3 and both
went untested — the audit found their mutations survived.

1. `view.ts` + `project.ts` + `state.ts` — the view built from entries, folding nothing.
   Verify invariants 1, 2, 3, 4 and 6 against recorded sessions, and check the rebuild
   against a `context` handler that runs before ours.
2. `status.ts`, reading `ctx.getContextUsage()`. No meter of our own (§7).
3. `menu.ts` + `compress.ts` + `dump.ts` + the nudge. First real folds. Two things the
   closure in §6 makes true and this step must respect: a mid-round span removes **more**
   entries than the model named, so a record's `msgs` must count what the projection
   actually removed rather than the span the model asked for; and a block whose entries have
   all left the view emits no summary, so this step carries that check (decision 29).
   Round enumeration
   lands **here**, with the assertion that pins it: one round per assistant message
   (measured 7,358 = 7,358 across the 23 recorded sessions). Step 1 wrote rounds ahead of
   this step and the test could not tell a wrong boundary from a right one — merging every
   adjacent pair kept the suite green. The menu partitions by round count, so an untested
   boundary is an untested menu.
4. `emergency.ts`.
5. `config.ts`, `log.ts`.

---

## 19. What has actually been verified

Written so this can be judged without reading seven audit reports. **Verified** means a test
or a measurement holds it; **observed** means it happened in a live Pi session; **argued**
means only reasoning supports it.

### Verified

**Verified once, on 2026-09-12, against a corpus of 25 recorded sessions on one machine — not
reproducible from this repository.** The tests that produced these numbers are deleted (§12);
what survives is this table. Read every row as a measurement that was made, not as a check
that runs.

| | Evidence |
|---|---|
| The view is rebuilt losslessly from session entries | byte-equality on **25 of 25** recorded sessions, ~16,000 entries |
| No tool result is ever emitted without its call | 2,813 blocks across the corpus, 0 orphans, 0 straddles |
| Historical message text is never modified | byte snapshot before and after every projection, fold path included |
| Coverage is round-aligned | the transitive closure, pinned by a mutation that restores the one-hop version |
| A fold that would replace nothing is refused | the stale-menu case, reproduced and tested |
| Blocks absorb correctly | chains of three, already-absorbed ids, entries already gone |
| Replay is deterministic | same log twice, identical state |
| Model-facing strings match this project's contract | §4 and §6 are still read from `docs/MODEL-FACING-TEXT.md` on every run, not copied; §1, §2, §3a, §3b, §5, §7, §8 and §9 were checked the same way by the deleted tests |

Across seven audit rounds, roughly **250 mutations** were run against the tree; the
survivors are listed in §17 and each is either equivalent or now covered.

### Observed live

A real fold, with the model afterwards reading its own folded file back **unprompted**. Four
folds in one session, each absorbing the last. A real overflow recovery: **40,644 tokens down
to 77**, every original still in the session file. A stale id rejected, then corrected by the
model on its own in the next call. One run against the real handler chain with `pi-goal-x`
loaded: 19 context events, 0 provider errors.

### Verified by the readiness review

| | Evidence |
|---|---|
| It builds and installs | `pi install <path>` records the path and Pi loads `src/index.ts` directly, so there is no build step; `private: true` and the missing `files` field are harmless because a local install copies nothing and Pi rewrites the peer imports to its own copies |
| It works in the owner's real extension set | `pi-lens`, `pi-goal-x`, `pi-powerline-footer`, `pi-mcp-adapter` all loaded; four folds, 33,970 → 20,113 tokens, no other extension misbehaved |
| Removing it is safe | a session with four folds and a compaction, re-run with the extension gone: 122 entries → 118 messages, all 34 tool results present, the model answered correctly. Folding is a view transformation only |
| Plausible user mishaps are recoverable | Ctrl-C mid-fold (self-heals), `--continue`, manual `/compact`, mid-session model switch, no config, unwritable cache (fails loudly, records nothing), two sessions on one project |

### Argued, not verified

- **Summary quality.** Nothing here measures whether the model writes summaries good enough to
  work from weeks later. That needs a long real session, and it is the thing most likely to
  disappoint.
- **The nudge cadence.** 200,000 tokens was chosen from a three-day sample where it would have
  fired six times. No session has yet run long enough to exercise it naturally.
- **Prompt-cache economics.** Folding costs cache by construction; the measured median retained
  prefix is 33%. Whether the trade pays over a month is unmeasured.
- **Two gaps §8 declines to handle:** `prepareCompaction` returning `undefined`, and a `/model`
  switch suppressing overflow detection. Both are unobserved, both are logged if they occur.

### What would make it trustworthy

Run it on a session you can afford to lose, with `debug: true`, and read
`~/.pi/agent/context-fold.log`. The three things worth watching: whether folds actually reclaim what
they claim, whether the model ever folds something it then needs back, and whether the nudge
fires at a sensible moment.

---

## 17. What the audit changed

| | Was | Now | Forced by |
|---|---|---|---|
| 19.1 | Map `event.messages` by position | Build the view from entries | `pi-goal-x` deletes messages before we run |
| 19.2 | All reads from `buildContextEntries()` | State from `getBranch()` | our own records vanish after a Pi compaction |
| 19.3 | Ordinals never renumber | Stable within a branch | `branch()` rewrites the chain |
| 19.4 | Drop the whole assistant message | Remove the tool-call block, strip thinking | 8.6% carry 2+ tool calls; orphan results are not repaired |
| 19.5 | — | confirmed safe | signatures are per-block; 69% of messages carry them |
| 19.6 | — | show both numbers | Pi's footer reads the untransformed session |
| 19.7 | `real` is always a measurement | use Pi's `getLastAssistantUsage` | 75 error/abort messages carry zero usage |
| 19.8 | "we can subtract exactly" | report unknown until the next anchor | two rulers; one fold reclaimed 233K |
| 19.9 | Re-anchor on any fold | only if `predicted` fell | a 712-token fold would silence the nudge |
| 19.10 | Return `firstKeptEntryId` | validate it first | a bad id silently wipes all history |
| 19.11 | Let it throw | never throw; mechanical fallback | a throw hands the turn to Pi's raw summariser |
| 19.12 | Lenient argument parsing | `JSON.parse` | C2 — the evidence is a Qwen and a local 27B |
| 19.13 | `sanitize.ts` | deleted | C2 — #309 is the same 27B |
| 19.14 | Skill de-duplication | deleted | unproven assumption that drops content |
| 19.15 | `bash.command` skill match | `read.path` only | Pi picks one skill read tool |
| 19.16 | Unknown id returns the menu | returns an error | 5K–100K to answer a malformed call |
| 19.17 | Hide failed folds | keep the newest visible | 3,849 identical calls over 5h13m |
| 19.18 | `recall` searches | fetch only | summaries are already in context |
| 19.19 | Self-calibrating ratio | fixed chars/4 | C10 bans learned values |
| 19.20 | Two `0.25` constants | deleted | both invented, neither binds |
| 19.21 | Menu ~15K, uncapped | 200 entries by even token weight, ~5K | density is up to 6.76 rounds/1K, not 1 |
| 19.22 | `/acp` usage bar | Pi's footer + our delta | duplicated what Pi shows |
| 19.23 | mtime config reload | read once | scar from a 36-key public product |
| 19.24 | Tolerance guard in §3 | gone with the positional map | invented constant |

**Simplification pass, 2026-09-12 (second round):**

| | Was | Now | Why |
|---|---|---|---|
| 19.25 | Durable round ordinals `r412` | ephemeral menu entry ids `e1…e200` | the model never needed a round id; kills ordinal stability, fork renumbering and one invariant |
| 19.26 | `/acp` panel, 80 lines | one `setStatus` footer line | duplicated Pi's footer and the log |
| 19.27 | A separate post-fold note | block id prefixed on the summary | one fewer synthetic message |
| 19.28 | `predicted = real + tail − reclaimed + added` | `predicted = real + tail` | the correction only ever covered one round, and mixed two rulers |
| 19.29 | Overflow summarised by a model | first 50% written to a file, replaced by a note | no model call means no timeout, no rate limit, no fallback |
| 19.30 | `log.ts` levels, `config.ts` merge | one line writer, twelve lines | scars from a public product |

**Simplification pass, third round:**

| | Was | Now | Why |
|---|---|---|---|
| 19.31 | H2 "not already covered by an active block" | deleted | the menu is partitioned from the view; folded content is not in the view |
| 19.32 | User messages "kept in place", skills "never folded" | one rule — *later deleted entirely, see 19.39* | a skill load is a tool result, so exempting it orphans the result |
| 19.33 | Blocks listed separately, second id namespace | block summaries are ordinary entries | folding one is just folding; no separate concept |
| 19.34 | Partition by token weight | partition by round count | at 200 entries the distinction does not pay for itself |
| 19.35 | `recall` tool | originals written to a file at fold time, path on the summary | smaller surface *and* the model gains `grep` across everything folded |
| 19.36 | Collapse older failures to one line | leave all failures untouched | machinery for a case whose two causes are both excluded |
| 19.37 | Folding guidance in the system prompt | moved to the nudge | later in context, and paid twice a day instead of every request |
| 19.38 | `[context]` prefix, invented | Pi's own `<summary>` / `<pi-context-fold>` elements | bracket markup on content is what the model echoed in the original; and Pi already taught it what `<summary>` means |
| 19.39 | Protected content, two drafts of it | nothing is protected; the instruction says what not to fold | a skill load is a tool result, so exempting it orphans the result; C8 says fix the information |
| 19.40 | A throw in the `context` handler | never throw; skip the unusable record | `emitContext` catches and sends the **unfolded** history, which overflows a folded session |
| 19.41 | Folding guidance in the nudge | in the menu (MODEL-FACING-TEXT.md §3a) — *split again, see 19.67* | the nudge fires in 6 of 26 sessions; the menu is mandatory before any fold |
| 19.42 | "do not fold standing requirements" | "quote them verbatim in the summary" | an entry spans ~34 rounds and there is no exclusion mechanism, so avoidance is not executable |
| 19.43 | "ours and Pi's numbers diverge permanently; that is the diagnostic" | they are identical by construction; the comparison is a cross-check | measured identical on 23/23 sessions — both use the same anchor and the same estimator |
| 19.44 | "folded blocks are unaffected" by overflow | *(superseded by 19.47)* | |
| 19.45 | Our own meter, 184 lines | `ctx.getContextUsage()` | identical on 23/23 sessions, and 10× wrong where it differed — C5 |
| 19.46 | Coverage shrunk to keep a result whose call survived | coverage extended under the call↔result closure | the shrink caused an orphan result, a moved summary, and a silent no-summary path |
| 19.47 | Detect a block orphaned by the cut | make the cut never orphan one | *(reverted by 19.57 — measured to free zero tokens)* |
| 19.48 | "the closure means the summary always lands at the first covered entry" | earliest covered position with no tool call pending | reproduced: a two-call assistant message puts the summary mid-round, and pi-ai then fabricates a tool failure |
| 19.49 | "a compaction cut only removes a prefix, so coverage is contiguous in the view" | `buildContextEntries` **hoists** the newest compaction entry to the front, so coverage can split | 13 compaction entries across 5 of 23 sessions; 2 sessions already have two or more |
| 19.50 | "menu tokens are excluded from the growth measurement" | they are not; the menu result just leaves the view next round | the arithmetic was wrong (20K, not 200K) and Pi's single number has nothing to subtract from |
| 19.51 | A "hold the summary until no call is pending" condition | complete the closure's transitivity instead | the mid-round case becomes unrepresentable rather than handled — C4 |
| 19.52 | "excluding compaction entries makes coverage contiguous" | it does not; coverage can split regardless | a span with no compaction entry, contiguous when folded, splits when a newer compaction hoists past an older one |
| 19.68 | Every nudge wakes the model with `triggerTurn: true` | only the last one does | a message the model may ignore is not worth a model call; the rule it was copied from is pi-background's finished job, where the user is waiting on the result |
| 19.67 | All folding guidance in the menu (19.41) | split: what qualifies for a fold is in the nudge, span and summary rules stay in the menu | deciding *whether* to fold happens before the menu is paid for, so the rules for that decision sat behind the 5.4K call the model needed them to judge |
| 19.66 | Validate `firstKeptEntryId` against `branchEntries` | deleted | the cut point comes from `buildContextEntries()`, a subset of the branch, so a bad id is unrepresentable — and the check's only action was a throw, which 19.65 forbids |
| 19.65 | "throws only when no cut exists" | never throws; a one-round view returns a no-op compaction and Pi reports the failure | a throw hands the turn to Pi's raw summariser — the D5 disaster — so printed-and-fatal beats nothing only in appearance |
| 19.64 | `fold N blocks · NK folded` | `folded 312K, 4 blocks` | the reclaimed total is the number worth reading first; `fold` as a bare prefix said nothing the numbers did not |
| 19.63 | The status line shows a context number | it shows blocks and folded tokens only | it duplicated Pi's own footer, and at 80 columns `pi-powerline-footer`'s overflow row silently dropped the whole line — measured |
| 19.61 | A fold-orphan check, and MODEL-FACING-TEXT §5's row for it | deleted | with one span per call the case is unrepresentable; the `turn_end` log still *reports* a block without a summary, which is observation, not enforcement — C4, C10 |
| 19.62 | "the emergency handler must never throw" | it never *cancels*; it throws only when no cut exists, and keeps two deliberate catches | a cancel is a silent dead turn, and deleting the log catch routes a log failure into the raw summariser |
| 19.59 | `compress` takes an array of spans | one span per call | the model never batched in any live run, and the array produced three defects; one span makes them unrepresentable — C10, C4 |
| 19.60 | `halfway` throws when no boundary frees half, and the handler cancels | fall back to the last boundary; delete the catch | a cancelled automatic compaction is a silently dead turn, and the design says "never cancel" |
| 19.57 | "the cut never orphans a live block" | cut at the earliest round boundary freeing half; orphaned blocks' summaries go in the note | measured: the never-orphan rule freed **0 tokens on 10 of 10** sessions, against 35K–184K — it fails hardest when the model has been folding |
| 19.58 | Decision 29's cast is "social until step 5" | it is permanent | C10 (one writer, one version, C1 forbids back-compat) and D2 (`liveBlocks` runs in the `context` handler, where "skipped and logged" cannot do I/O) |
| 19.56 | `session_start` anchors the baseline on the current context | it starts at 0 | resuming an 800K session made the nudge unreachable; starting at 0 deletes the special case instead of adding a resume rule — C4 |
| 19.54 | The menu's example used fixed ids `e1 … e37` | it names ids from the table it sits under, and an empty menu prints no example | live: the table was empty and the model folded `e2–e3`, which did not exist |
| 19.55 | The nudge is appended by the `context` handler each turn | it is a persisted Pi message sent at `turn_end` | appending in the handler is a decision inside a handler D2 requires to be pure; persisting costs ~48 tokens per nudge (~6 per three days) and survives restarts |
| 19.53 | A fixpoint closure over the call↔result relation | two bounded hops | measured max eccentricity 2 over 6,666 components; and a fixpoint would cascade coverage across unrelated rounds if a call id were ever repeated, where a bounded pass cannot — the general version is the *less* safe one |

Module estimate: **~950 lines**; the tree is 914. Down from ~990, ~1,385, ~1,810 in the first draft, and
~9,950 in the original.

---

## 18. The two numbers, settled

**1. `nudgeGrowthTokens`.** You chose 200,000. Simulated against your real logs (5,228
per-turn deltas across 26 sessions, three days):

| Step | Nudges fired | Sessions reaching a second nudge |
|---|---|---|
| 50,000 | 49 | 21 |
| 100,000 | 18 | 11 |
| **200,000** | **6** | **0** |

No single turn ever grows more than 90,764 tokens, so the step is cumulative. At 200K the
rule fires roughly twice a day and no session is ever nudged twice. **Settled at 200,000**
— chosen knowing the measurement, on a 1M window where pressure is rare.

**2. `MENU_MAX`.** Settled: **200**, divided evenly by round count (§5). ≈ 5K tokens per
menu. A constant in the source, not a config key.
