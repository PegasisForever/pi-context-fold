# pi-context-fold

Model-driven context folding for the [Pi](https://pi.dev) coding agent.

When a session grows large, the model is asked to fold spans of its own older conversation
into summaries it writes itself. The original text is written to disk, so nothing is lost
and everything ever folded stays greppable.

Personal tool. One user, one machine, not published. See `DESIGN.md` for the constitution
that governs it — that document outranks the code.

| Document | Contents |
|---|---|
| `DESIGN.md` | architecture, the verified Pi seams, invariants, build order |
| `PROMPTS.md` | every string the model ever sees, with its token budget |
| `docs/FEATURES.md` | the feature pick list this was scoped from |

One tool (`compress`), three config keys, ~950 lines.
