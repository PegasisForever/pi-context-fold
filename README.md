# pi-context-fold

Model-driven context folding for the [pi](https://github.com/badlogic/pi-mono) coding agent.

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

- **Almost nothing to see.** No command, no on/off switch. One footer line, and one row
  per fold. It manages itself.
- When context has grown by 200K tokens, a 147-token nudge is added to the conversation. It
  reports the pressure and says what is worth folding; the model decides. Nothing is required
  of it, and it does not interrupt what you are doing.
- Once there is no room left for another nudge, the last one says so and asks for the fold.
  That is the only one that starts a turn of its own, because after it the window fills and
  the older half of the session is cut from view with no summary.
- The model calls `compress()` with no arguments and gets a menu — the foldable conversation
  partitioned into at most 200 contiguous entries, `e1…e200`.
- It picks a span and writes a summary. That span leaves the view, replaced by
  `<summary block="b5" msgs="38" tokens="412K→3.1K" original="…/b5.txt">`.
- The original goes to `~/.pi/agent/context-fold/<session>/b5.txt`. The model is told in its
  system prompt to search that folder before asking you to repeat something — and it does.
- On a context overflow, the older half is cut mechanically and written to a file. No second
  model call, no summarisation that could fail.

Nothing is ever deleted. Folding is a transformation of what gets *sent*; the session log
keeps every original message, so **removing the extension restores the full conversation**.

## Install

Straight from GitHub:

```bash
pi install git:github.com/PegasisForever/pi-context-fold
```

Or from a clone, which is what you want if you are editing it:

```bash
git clone https://github.com/PegasisForever/pi-context-fold
pi install ./pi-context-fold
```

Add `-l` to either to install into the current project instead of your user settings. To
pull a newer version later:

```bash
pi update git:github.com/PegasisForever/pi-context-fold
```

There is no build step. Pi runs the TypeScript in `src/` directly, so an edit takes effect
the next time you start a session. `pi install` of a local path records the path — it does
not copy — so moving or deleting the directory breaks the install silently.

## Config

None. There is no configuration file and no key to set. The three that once existed were
never set by anybody, so they are constants in the source.

Setting `PI_CODING_AGENT_DIR` moves everything this writes — the folded originals and the
log — along with pi's own directory.

Worth running `tail -f ~/.pi/agent/context-fold.log` for the first session: one JSON line per
fold, per nudge, and per block it can no longer use.

## Showing it in pi-powerline-footer

The status line reaches the footer through `setStatus`, under the key `pi-context-fold`.
Powerline puts it in an overflow row that silently drops what does not fit. Give it a
dedicated segment instead:

```jsonc
"powerline": {
  "customItems": [
    { "id": "fold", "statusKey": "pi-context-fold", "position": "right",
      "hideWhenMissing": true, "excludeFromExtensionStatuses": true }
  ]
}
```

## Remove

```bash
pi remove ~/pi-context-fold
rm ~/.pi/agent/context-fold.log
rm -rf ~/.pi/agent/context-fold      # only when no folded session still matters
```

A folded session works fine without the extension — Pi projects the full original history.
Verified on a session with four folds and a compaction: 122 entries, 118 messages, all 34
tool results present.

## Documents

| | |
|---|---|
| `docs/DESIGN.md` | the Constitution, the architecture, and §17 — every change some review forced, with its evidence |
| `docs/DESIGN.md` §19 | what is **verified**, what was **observed live**, and what is only **argued** |
| `docs/MODEL-FACING-TEXT.md` | every string the model ever sees, with its token budget, and every string you see |
| `docs/FEATURES.md` | the scoping exercise this came out of |

`docs/DESIGN.md` opens with a Constitution that outranks the design, which outranks the code. Ten
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
- Only the last nudge starts a turn of its own, so at most one fold costs a model call you did not ask for.

## Size

**949 lines of source, 4 tests.** One tool, no config, no slash command.

The extension it replaces is ~9,950 lines. Roughly 250 mutations were run against this tree
across seven review rounds; §17 records what each one changed.

## Licence

MIT.
