# Feature pick list

The scoping exercise pi-context-fold came out of: every feature of
`billion-context-pi` (the thing it replaces), with what was taken and what was not.

Tick what you want. `[x]` = my recommended minimum, already ticked.
Untick anything you do not need. Add notes in the **Notes** column.

Effort numbers are my estimate of new source lines in the rewrite.
For comparison: the current plugin is ~9,950 lines of source plus ~12,100 lines of tests.

---

## A. Core compression — the reason the plugin exists

| Pick | ID | Feature | What it does | Effort | My call |
|---|---|---|---|---|---|
| [x] | **A1** | Message addressing | Gives the model a name for each message so it can say "compress from here to here". | ~80 | Required. Uses Pi's own entry ids, not tags written into message text. |
| [x] | **A2** | `compress` | Replaces a range of messages with one summary the model writes. | ~250 | Required. |
| [x] | **A3** | Projection | Removes covered messages from what gets sent, puts the summary in their place. | ~150 | Required. |
| [x] | **A4** | Protected content | Never compresses the last N messages, user messages, or named tools. | ~60 | Recommended. Cheap, prevents the worst mistakes. |
| [x] | **A5** | Token accounting | Decides how full the context is. | ~100 | Required. Reads the provider's reported number instead of guessing. Today this is ~600 lines across 6 correction layers. |
| [x] | **A6** | State persistence | Compression survives restart and session fork. | ~80 | Required. Uses Pi's `appendEntry`, so no sidecar file. |
| [x] | **A7** | Nudge | Tells the model it is time to compress, and which ranges are worth it. | ~150 | Pick A7 **or** A8, or both. A7 alone is the source of the loop bugs. |
| [ ] | **A8** | Automatic fallback compression | If pressure is high and the model has not acted after N turns, the plugin summarises the oldest range itself with a cheap model. | ~200 | Recommended instead of A7. Removes the whole loop-bug family. |
| [ ] | **A9** | Emergency truncation | Last-resort mechanical trim of huge tool results when close to the limit. | ~80 | Recommended. Safety valve. |
| [ ] | **A10** | Multi-tier distillation (T1 → T2 → T3) | Compresses old summaries into higher-level summaries. | ~200 | Optional. Only matters for sessions that run for weeks. |
A10 note: we dont need multi tier. one tier is enough, and the model can still choose to summarize multiple summarization blocks, its just the summarized block after that is still the same tier, no special treatment.
| [x] | **A12** | Skill persistence | Never compresses skill content. Pi lists skills in the system prompt by name and file path only; the body enters the conversation as a `read` tool result, so today it is compressed like any other tool output and the instructions are lost. | ~90 | **Required (added 2026-09-12).** Uses Pi's own skill registry (`before_agent_start` → `systemPromptOptions.skills`), so the match is exact, not a guess: any tool result whose call touched a path under a skill's directory is protected. Includes de-duplication — re-reading the same skill keeps only the newest copy. |
| [ ] | **A11** | Block promotion and auto-merge | Ages blocks "young" → "old" and batch-merges old ones. | ~150 | Skip. Overlaps A10 and adds state. |

**Notes:**

---

## B. Model-facing tools

| Pick | ID | Tool | What it does | Effort | My call |
|---|---|---|---|---|---|
| [x] | **B1** | `compress` | See A2. | — | Required. |
| [x] | **B2** | `decompress` | Brings a compressed block's original text back. | ~120 | Recommended, simplified: block to file only. Drop the tier recursion and the inline mode. Current version is 281 lines. |
| [x] | **B3** | `search_context` | Keyword search across summaries and historical messages, ranked, with the decompress command for each hit. | ~150 | Recommended. This is what makes compression safe — the model can find what it folded away. |

B2 & B3 note: can we merge decompress and search_context? do we really need decompress if search_context already can give the model all the information it wants?

| [ ] | **B4** | `acp_status` | Context usage, token breakdown by category, active blocks, ranges worth compressing. | ~150 | Optional. Useful, but the model tends to call it in loops (their open issue #375). |

**Notes:**

---

## C. User-facing commands and UI

| Pick | ID | Command | What it does | Effort | My call |
|---|---|---|---|---|---|
| [x] | **C1** | `/acp` | Status panel: usage bar, token breakdown, block list. | ~150 | Recommended. You need to see what it is doing. |
| [ ] | **C2** | `/acp-status` | Longer version of C1. | ~100 | Skip. Fold into C1. |
| [ ] | **C3** | `/acp-decompress b3` | Restores a block for you to read. | ~40 | Optional. |
| [ ] | **C4** | `/acp-search` | Human-side keyword search. | ~40 | Optional. |
| [ ] | **C5** | `/acp-export` | Writes a session handoff document to a file. | ~170 | Skip unless you want it. |
| [ ] | **C6** | `/acp-subagents` | Writes ACP tool names into pi-subagents' `settings.json`. | ~290 | Skip. Only for pi-subagents users. |
| [ ] | **C7** | `/acp-fleet` | Full-screen view of running sub-agents and their transcripts. | ~600 | Skip unless you take group E. |
| [ ] | **C8** | Live status widget | Shows running sub-agents under the editor. | ~130 | Skip unless you take group E. |

**Notes:**

---

## D. Reliability patches — workarounds for models and providers

Each of these exists because a real session broke. Most are model-specific or provider-specific.

| Pick | ID | Feature | What it protects against | Effort | My call |
|---|---|---|---|---|---|
| [x] | **D1** | Lenient `compress` argument parsing | Models that send the range list as a string, with a missing `}`, or wrapped in a code fence. | ~60 | Recommended. Cheap, saves whole turns. |
| [ ] | **D2** | Compress loop breaker | The model retrying the same failing compress forever. | ~120 | Not needed if you take A8. |
| [ ] | **D3** | Tool repetition guard | Any tool called with byte-identical arguments N times in a row. Warns, then aborts. | ~100 | Optional. A general agent safety feature, not a compression one. |
| [ ] | **D4** | Degeneration guard | A model that starts emitting the same character thousands of times, which then poisons every later request. | ~150 | Take it only if you run small or local models. |
| [ ] | **D5** | Reasoning drop | Strips the model's thinking text from past compress calls, which otherwise rides along in every request forever. | ~120 | Optional. Real token saving, but provider-specific and fragile — it already needed a "strict echo" exception. |
| [ ] | **D6** | Context-overflow self-heal | The provider rejects the request as too long. Learns the real window size from the error text and forces compression next turn. | ~200 | Skip if you take A5. A correct token count makes it unnecessary. |
| [ ] | **D7** | Provider throttle retry | Rate-limit errors: rewrites the error so Pi retries, then sleeps and re-prompts. | ~200 | Take only if your provider rate-limits you. Belongs in its own plugin. |
| [ ] | **D8** | Bash timeout and output cap | Default timeout on `bash`, and a byte cap on tool output. | ~150 | Genuinely useful, but unrelated to compression. Own plugin. |
| [x] | **D9** | Summary sanitising | Fixes double-escaped text in summaries, flags invented user quotes. | ~80 | Recommended. Stops a bad summary becoming permanent. |
| [x] | **D10** | Output headroom | Reserves part of the window for the model's reply. | ~30 | Recommended. One piece of arithmetic, capped. |
| [ ] | **D11** | Prefix-cache stabilisation | Freezes the injected tags so historical text never changes. | — | Disappears in the rewrite. Nothing is written into message text, so there is nothing to freeze. |
| [x] | **D12** | Image token accounting | Counts images at a flat 1600 tokens each. | ~30 | Take it if you send images. |

**Notes:**

---

## E. Sub-agents (`acp_delegate`) — about 2,600 lines today

| Pick | ID | Feature |
|---|---|---|
| [ ] | **E1** | Spawn a child `pi` in a clean context with one of five roles (reviewer, researcher, worker, planner, oracle). |
| [ ] | **E2** | Per-role tool allowlist, so read-only roles cannot edit files. |
| [ ] | **E3** | Async runs, with a completion message injected into the chat when the child finishes. |
| [ ] | **E4** | `acp_delegate_wait` and `acp_delegate_cancel` tools. |
| [ ] | **E5** | Watchdogs: idle timeout, hard timeout, forced finish. |
| [ ] | **E6** | Nesting depth limit, concurrency limit, resume a failed run. |
| [ ] | **E7** | Cost and token tracking per child. |
| [ ] | **E8** | Skips the completion message if the model already read the result file. |

**My call: skip the whole group.** You already have separate tooling for that, and this is the second-largest source of fix commits in the project. If you want any of it, take it as a separate plugin, not inside the compression one.

**Notes:**

---

## F. Host plumbing and self-management

| Pick | ID | Feature | Effort | My call |
|---|---|---|---|---|
| [x] | **F1** | Cancels Pi's built-in auto-compaction, so there is exactly one context manager. | ~5 | Required. |
| [x] | **F2** | System prompt injection — teaches the model the tools and the compression rules. | ~120 | Required. Mostly prompt text. |
| [x] | **F3** | Config file (`~/.pi/context-fold.json` plus a per-project one), re-read live. | ~120 | Recommended. About 10 keys, against 40+ today. |
| [x] | **F4** | Structured log to `~/.pi/acp.log`. | ~80 | Recommended. You will need it. |
| [ ] | **F5** | Auto-update: checks npm and runs `npm install` inside the live session. | ~560 | Skip. A stability risk on its own. |
| [ ] | **F6** | OMP host detection and refusal. | ~40 | Skip. You run Pi. |
| [ ] | **F7** | `bili` proxy detection and stand-down. | ~40 | Skip. You do not use the proxy. |
| [ ] | **F8** | State rebuild by replaying the session log after import. | ~170 | Disappears in the rewrite. State lives in the session file already. |
| [ ] | **F9** | Parent-session state inheritance for forks and clones. | ~60 | Disappears in the rewrite, same reason. |
| [ ] | **F10** | Per-provider and per-model config overrides. | ~60 | Optional. Only if you switch models mid-session. |
| [ ] | **F11** | User-supplied prompt text overrides. | ~90 | Skip. |
| [x] | **F12** | Per-session bookkeeping, so several sessions in one process cannot share state. | ~40 | Required. |

**Notes:**

---

## Totals

- **Ticked above (my suggested minimum):** roughly **1,800–2,200 lines**.
- Covers: compression that works, search so nothing is lost, a status panel, automatic action when the model does not act, and a log.
- Leaves out every feature that caused a recurring bug in the original.

Suggested additions, by situation:

- Sessions that run for weeks → add **A10**.
- You send images → add **D12**.
- You run small or local models → add **D4**.
- Your provider rate-limits you → add **D7**.

---

## Two questions I cannot answer for you

**1. For A8 (automatic fallback compression), which model should write the summaries when the main model does not act?**

Answer here: N/A

**2. Is this plugin only for your fleet, or something you may publish?**

This changes how much configuration, host detection and documentation is worth writing.

Answer here: only for RMNG

---

## Anything else you want that the original does not have?

Answer here:
