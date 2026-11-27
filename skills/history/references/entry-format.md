# History entry format — full spec

Source of truth for the shape enforced by `../SKILL.md`. Inside hos, `history_append` writes exactly this shape
(hos's `historyBlock`); write by hand only outside hos.

## Path and file

```
history/
  2026/
    09/
      2026-09-03.md      ← one file per day; ISO date; zero-padded month folder
```

- Year folder = `YYYY`, month folder = `MM`, file = `YYYY-MM-DD.md`, the date in hos's time zone
  (`owner.timezone` in `hos/policy.yaml`, else the system zone). No other layout.
- First line of a new day file: `# YYYY-MM-DD` (an H1 date, nothing else). No preamble, no index.
- Blocks are appended in chronological order. A blank line separates blocks.
- Append-only. Editing or deleting a past block is a correction of the record and is not allowed;
  write a new block that says what was corrected.

## Block shape

```markdown
## HH:MM <zone> · <branch> · <title ≤ 12 words>
- Asked: …
- Did: …
- Wrote: …
- Open: …
```

| Field | Rule |
|---|---|
| `HH:MM` | 24-hour time in hos's time zone when the task *finished*, from `TZ=<zone> date '+%H:%M'`. Never estimated. |
| `<zone>` | One word: `owner.timezone_label` from `hos/policy.yaml` when set, else the zone's short name (`date +%Z`). Match the label earlier entries in the same file use. |
| separator | ` · ` (U+00B7 middle dot, space on both sides), exactly twice in the heading. |
| `<branch>` | `git branch --show-current`, verbatim (e.g. `main`, or `feat/webhook-retry`). |
| `<title>` | ≤ 12 words, imperative or noun phrase, specific enough to grep for later. |
| `Asked` | What the user asked, in their terms, including mid-task redirections ("then: plan only"). |
| `Did` | What actually happened. Numbers, names, outcomes. Include failures and what was skipped. |
| `Wrote` | Absolute paths only, comma- or `+`-separated. `none` if nothing was written. |
| `Open` | Outstanding work / next step, or `none`. This is what a resumed session reads first. Steps only the user can do are `[user]` items. |

Bullets may wrap, but keep each to one or two lines. Long reasoning, tables, and evidence go into the
work folder `work/<area>/<YYYY-MM-DD>-<slug>/` and are referenced by path from `Wrote`.
A work folder link that no longer resolves (hos renamed the folder): `rg -F '<old path>' work/_meta/MOVED.tsv`.

## Grading claims inside an entry

Match the brain's convention: `reproduced` / `code-inferred` / `data-inferred` / `unverified`. Use it inline
when a `Did` bullet asserts something non-obvious, e.g. *"proved the commit hook on a scratch copy
(reproduced)"* or *"the editor's settings file name (unverified)"*.

## What does not belong in history

| Content | Where it goes |
|---|---|
| Personal reflection, diary, mood | outside the brain (the user's own notes) |
| Durable decisions, standing preferences, long-lived open loops | `shared/MEMORY.md` when it holds for every profile, else `profiles/<id>/MEMORY.md` |
| Task output, plans, progress: reports, syntheses, galleries, `PLAN.md`, `PROGRESS.md`, images | `work/<area>/<YYYY-MM-DD>-<slug>/` |
| Raw agent streams, dumps, code trees, anything > 5 MB | `<work folder>/raw/` (git-ignored) |
| Secrets, tokens, connection strings | nowhere — the commit's secret scan aborts the commit on a match |

## Anti-patterns seen in practice

- Backfilling a guessed timestamp instead of running `date`.
- Relative paths in `Wrote:` — useless a month later from a different worktree.
- One giant block for a multi-task session; one block per task is the unit.
- Rewriting an earlier block to "tidy" it — the log's value is that it is append-only.
- Restating the artifact's whole content in `Did` — link it instead.
- Omitting `Open` entirely; write `Open: none` so a reader knows it was considered.
