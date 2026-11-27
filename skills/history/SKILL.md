---
name: history
description: >-
  Append-only work log for the brain and search over it. Use at the end of every
  task to record what was asked, done, and written ("log this to history",
  "append a history entry", "record this run"), and whenever the user asks what
  past work happened — "what did we do yesterday", "what did I do on 2026-08-14",
  "history of the billing migration", "search history for rate limits", "where did we
  leave off", "continue on X / resume X / get context on X". Owns the
  history/YYYY/MM/YYYY-MM-DD.md entry format, the resume recipe (from a work
  folder's PROGRESS.md) and the `rg` search recipe, and
  explains why you must never `git commit` here (hos, or the Stop hook outside hos, does it). NOT for
  personal reflection or diary entries (those belong outside the brain), NOT for
  durable decisions and open loops (those belong in `shared/MEMORY.md`, or `profiles/<id>/MEMORY.md` for one profile), NOT for task
  outputs or PROGRESS.md edits (those go in the work folder work/<area>/<date>-<slug>/;
  update-progress writes PROGRESS.md), NOT for git history
  spelunking in other repos (use `work-in` there).
---
# History

Paths and commands here are relative to the brain: the folder hos runs chats in, and the one `$WORK_DIR` sits in
(run them there, or with `git -C <brain>`).

One file per day, append-only: `history/YYYY/MM/YYYY-MM-DD.md`. One `##` block per task.
It is the brain's memory of *what happened*; `shared/MEMORY.md` (every profile) and `profiles/<id>/MEMORY.md` (one profile) are the memory of *what was decided*;
the work folder's `PROGRESS.md` (`work/<area>/<YYYY-MM-DD>-<slug>/PROGRESS.md`) is *where a piece of work stands now*
(sections and rules: the `update-progress` skill).

Dates and times follow the time zone hos is configured with: `owner.timezone` in `hos/policy.yaml`, else the
system zone. The day file is the date in that zone.

**Inside hos** (a `[hos briefing]` is in context): don't edit `history/` or `PROGRESS.md` yourself. Call the hos tools
`history_append` (title, asked, did, wrote, open) and `progress_update` (through `update-progress`); hos writes and
commits them, with the time, zone and branch filled in.

Depth: `references/entry-format.md` (format + quality bar + examples), `references/auto-commit.md`
(how commits land outside hos, log lines, failure modes).

## Never commit by hand

**Never `git commit` by hand here.** Inside hos, hos commits brain edits itself. Outside hos, the `Stop` hook
(`.claude/hooks/auto-commit.sh`) commits automatically after every assistant turn and pushes when the branch has an
upstream. Also never `git add`, `git push`, `git rebase`, or amend in the brain. Write the entry, end the turn, and
it is committed for you. Manual commits fight the hook and hos's own commits.

If `git status` still shows changes after a turn outside hos, the hook failed. Then and only then:

```bash
bash .claude/hooks/auto-commit.sh manual && tail -3 "$(git rev-parse --git-dir)/auto-commit.log"
```

Report the log line. Do not "fix" it with a hand commit.

## Write an entry (every task, before your final message)

One entry per **deliverable**: a plan, a fix, an artifact, an answer, a decision. A pure ops turn (server
restart, commit, push, merge, branch rename) gets no entry of its own; fold its outcome (commit hash, PR
number) into the next deliverable's entry.

Inside hos, step 4 then one `history_append` call is all; steps 1–3 are for writing by hand outside hos.

1. Get the local time, zone and current branch — do not guess any of them:
   ```bash
   TZ=<hos time zone> date '+%F %H:%M %Z'; git branch --show-current
   ```
2. Ensure the day file exists: `history/YYYY/MM/YYYY-MM-DD.md`, first line `# YYYY-MM-DD`.
3. **Append** one block. Never rewrite, reorder, or delete earlier blocks — including your own from
   earlier in the same session (add a new block instead).

```markdown
## HH:MM <zone> · <branch> · <title in ≤ 12 words>
- Asked: what the user actually asked, including mid-task changes of direction
- Did: what was done — concrete, with numbers, names, and outcomes
- Wrote: absolute paths of every file created or modified
- Open: what is still outstanding, or `none`
```

Rules: 24-hour time and the zone label (`owner.timezone_label` in `hos/policy.yaml` when set, else the short name
`date +%Z` prints); branch exactly as `git branch --show-current` prints it; `Wrote:` holds absolute paths only,
never relative ones; keep each bullet to one or two lines — depth belongs in the artifact you wrote, not here.
Omit `Open` only by writing `none`. A step only the user can do goes in `Open` as a `[user]` item, and also at the
end of your reply and in PROGRESS.md Open.

4. Before the entry, run `update-progress` for the work folder the task wrote into: State and Next step always,
   Next step matching this entry's `Open`.

**Work folder rules.** Inside hos it is the briefing's `Work folder:` line (`$WORK_DIR`). Outside hos and on Desk pick one per
deliverable: `work/<area>/<YYYY-MM-DD>-<slug>/` (areas in `work/README.md`, date = the day the work started); continuing work uses
its existing folder (`ls -d work/*/*<slug>*`). Everything the work makes (PLAN.md, PROGRESS.md, reports, images) sits inside it; no
month folders, no shared `assets/`. >5 MB, raw streams or code trees → `<folder>/raw/` (gitignored). A work folder hos renamed is
listed in `work/_meta/MOVED.tsv`. End the reply with absolute paths: ≤5 files → one per file; more → the folder.

Example (a made-up day file, `history/2026/09/2026-09-03.md`):

```markdown
## 12:25 CET · main · Plan the move of the brain's notes into work folders
- Asked: restructure the brain so each piece of work has one folder; then "plan only, with supporting docs"
- Did: listed 214 loose notes, grouped them into 9 areas, proved the commit hook on a scratch copy (reproduced)
- Wrote: <brain>/work/misc/2026-09-03-work-folder-move/PLAN.md (+ docs 01–06)
- Open: execute PLAN.md phases 1–5 with helper chats
```

(`<brain>` stands for the brain's absolute path; a real entry writes it out.)

## Resume a topic ("continue on X", "where did we leave off on X", "resume X")

1. Find the work folder: inside hos the briefing's `Work folder:` line; else `ls -d work/*/*<slug>*`; a folder
   that moved → `rg -F '<old path>' work/_meta/MOVED.tsv`. Unclear → `ls work/*/` and pick or ask.
2. Read its PROGRESS.md from `main`, since another workspace or computer may have updated it:
   ```bash
   git fetch -q origin main
   git show origin/main:<folder>/PROGRESS.md 2>/dev/null || cat <folder>/PROGRESS.md
   ```
   Then follow its Resuming order: `git log` on the Where branch, run Checks, do Next step.
3. `rg` history only for what PROGRESS.md leaves open (a commit hash, a decision's wording), with
   `-n -C2` and a date-scoped path, newest month first. Day files can run to tens of KB; read entries by line
   offset, never whole.
4. Done when you can state the next step and its exact workspace/branch. No PROGRESS.md → fall back
   to the latest day files below, then create it with `update-progress` at the end of the task.

## Search history

`history search <term>` means exactly this — case-insensitive, with line numbers:

```bash
rg -n -i "<term>" history/
```

Variants:

```bash
rg -n -i -C2 "rate limit" history/                 # with context
rg -n -i "billing|invoice" history/2026/08/        # one month, alternatives
rg -l -i "webhook" history/                        # which days mention it
sed -n '1,200p' history/2026/09/2026-09-03.md      # read one day
ls history/2026/*/ | tail -20                      # what days exist
git log --oneline -- history/                      # commit trail of the log itself
```

Answering "what did we do yesterday" / "where did we leave off" with no topic named: read the most recent day file(s)
directly (`ls history/2026/09/ | tail -3`), summarise the `Did` lines, and lead with anything still
under `Open`. Quote the entry rather than paraphrasing when the user asks what was decided, and say so
if the day file does not exist — an absent file means no entry was written, not that nothing happened.

## Boundaries

- Other repos have no `history/`. Log a task done in another repo in the *brain's* history; never
  create a `history/` folder inside another repo.
- If two workspaces write the same day file, both blocks survive: `.gitattributes` sets
  `history/** merge=union`, so git keeps both sides. If a conflict still shows, keep both; never drop a block.
- Secrets never go in an entry (the commit's secret scan aborts the commit for the whole turn).
