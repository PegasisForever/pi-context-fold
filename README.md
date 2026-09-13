# pi-context-fold

Model-driven context folding for the [Pi](https://pi.dev) coding agent.

When a session grows large, the model folds spans of its own older conversation into
summaries it writes itself. The original text is written to disk, so nothing is destroyed
and everything ever folded stays greppable.

```
folded 312K, 4 blocks
```

## Why

Most agents handle a full context window by truncating silently, or by replacing the whole
conversation with one machine-written summary. Both throw away the model's own judgement
about what mattered.

Here the model decides what to fold and writes the summary, because it knows which
exploration led nowhere and which error string it will need again. The extension only
decides *when to ask*, keeps the bookkeeping honest, and guarantees the recovery path.

The summary is an **index into recoverable text**, not a replacement for it — which is a
different instruction from every other harness, and the reason this one can be short.

## How it works

- **You see nothing.** No command, no on/off switch. It manages itself.
- When context has grown by 200K tokens, a ~43-token nudge appears at the end of the view.
- The model calls `compress()` with no arguments and gets a menu — the foldable conversation
  partitioned into at most 200 contiguous entries, `e1…e200`.
- It picks a span and writes a summary. That span leaves the view, replaced by
  `<summary block="b5" msgs="38" tokens="412K→3.1K" original="…/b5.txt">`.
- The original goes to `~/.cache/pi/context-fold/<session>/b5.txt`. The model is told in its
  system prompt to search that folder before asking you to repeat something — and it does.
- On a context overflow, the older half is cut mechanically and written to a file. No second
  model call, no summarisation that could fail.

Nothing is ever deleted. Folding is a transformation of what gets *sent*; the session log
keeps every original message, so **removing the extension restores the full conversation**.

## Install

```bash
git clone <this repo> ~/pi-context-fold
cd ~/pi-context-fold && npm install     # builds via `prepare`
pi install ~/pi-context-fold
```

`pi install` of a local path records the path — it does not copy. Moving or deleting the
directory breaks the install silently.

**After any source change, run `npm run build`.** Pi loads `dist/`, not `src/`.

## Config

`~/.pi/context-fold.json`, overridden by `<project>/.pi/context-fold.json`. Three keys.

```jsonc
{
  "nudgeGrowthTokens": 200000,  // re-nudge after this much growth
  "logFile": null,              // default ~/.pi/context-fold.log
  "debug": false
}
```

An unknown key throws and names it. A missing file uses the defaults.

Worth setting `"debug": true` for the first session, then `tail -f ~/.pi/context-fold.log`.

## Showing it in pi-powerline-footer

The status line reaches the footer through `setStatus`, which powerline puts in an overflow
row that silently drops what does not fit. Give it a dedicated segment instead:

```jsonc
"powerline": {
  "customItems": [
    { "id": "fold", "statusKey": "fold", "position": "right",
      "hideWhenMissing": true, "excludeFromExtensionStatuses": true }
  ]
}
```

## Remove

```bash
pi remove ~/pi-context-fold
rm ~/.pi/context-fold.json ~/.pi/context-fold.log
rm -rf ~/.cache/pi/context-fold      # only when no folded session still matters
```

A folded session works fine without the extension — Pi projects the full original history.
Verified on a session with four folds and a compaction: 122 entries, 118 messages, all 34
tool results present.

## Documents

| | |
|---|---|
| `DESIGN.md` | the Constitution, the architecture, and §17 — every change some review forced, with its evidence |
| `DESIGN.md` §19 | what is **verified**, what was **observed live**, and what is only **argued** |
| `PROMPTS.md` | every string the model ever sees, with its token budget |
| `docs/FEATURES.md` | the scoping exercise this came out of |

`DESIGN.md` opens with a Constitution that outranks the design, which outranks the code. Ten
principles; the two that did the most work were *"if Pi already knows it, read it"* and
*"when a failure appears, first ask which existing mechanism should go, not which new one to
add"*.

## Honest limits

- **Summary quality is unmeasured.** Nothing here proves the summaries are good enough to
  work from weeks later. Early warning: folds that compress to under ~3% are probably too
  thin.
- **The nudge cadence is a guess** from a three-day sample where 200K would have fired six
  times. No session has run long enough to exercise it naturally.
- **Folding costs prompt cache** by construction — the measured median retained prefix after
  a fold is 33%. Whether the trade pays over a month is unmeasured.
- The nudge does not start a turn; the model sees it on your next message.

## Size

**859 lines of source, 44 tests.** One tool, three config keys, no slash command.

The extension it replaces is ~9,950 lines. Roughly 250 mutations were run against this tree
across seven review rounds; §17 records what each one changed.

## Licence

MIT.
