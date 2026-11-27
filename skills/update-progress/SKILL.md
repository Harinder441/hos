---
name: update-progress
description: >-
  Update the PROGRESS.md of the current piece of work (its work folder under the brain's work/) so it is true now:
  State, Where, Decisions, Open, Next step, Log. Use at the end of every deliverable (right before history_append),
  when the user says "update progress", "update the progress doc", "where are we", "save progress", and as the
  first step of a continue-mode handoff (the handoff skill calls it). Not for history entries (history skill) or
  delegate briefs (handoff skill).
---

# Update progress

> `work/` is relative to the brain: the folder hos runs chats in, and the one `$WORK_DIR` sits in.

One `PROGRESS.md` per work folder (`work/<area>/<YYYY-MM-DD>-<slug>/`). Sections, in this order: Goal, State, Where,
Decisions, Open, Tried, Leave alone, Checks, Next step, Log. Required: Goal, State, Where, Open, Next step, Log;
Decisions when any exist; the rest optional.

## Find the file

1. **Inside hos** (a `[hos briefing]` is in context): the latest `Work folder: … (WORK_DIR=<abs>)` line in the
   conversation wins (the briefing repeats it after a rename), else `$WORK_DIR`. Work that belongs to another existing
   work folder (Desk, or a topic reused for unrelated work) → pass that folder as `folder` to `progress_read` and
   `progress_update`.
2. **Outside hos:** the work folder this session writes into. Continuing work → its existing folder
   (`ls -d work/*/*<slug>*`). None fits → make `work/<area>/<YYYY-MM-DD>-<slug>/` (areas in `work/README.md`,
   date = the day the work started).
3. **Missing file** → start from [`references/template.md`](references/template.md) and fill Goal, State, Where and
   Next step in this first write.

## Update

1. **Read** the whole file now (inside hos: `progress_read {folder?}`, which also returns each section's `rev`).
2. **Decide the sections** that changed. End of a deliverable: State and Next step always, plus any other that moved.
   Handoff: State, Open and Next step always, Tried if anything failed.
3. **Fix, never caveat.** A line that turned false is replaced or deleted. Never add "below is outdated" or
   "update: …". Superseded decisions keep their line with `superseded by <ref>`. Failed approaches move to Tried.
4. **Keep it small.** State ≤ 10 lines. The file stays under 20,000 characters (hos refuses more, warns from 8,000):
   move detail into a file in the work folder and link it under Where.
5. **No duplicates.** Decisions live in PROGRESS.md Decisions, one line each.
   Work lives in hos tasks (`task_create`), never in Open or Next step: Open holds only questions for the user and
   `[user]` steps only they can do, and a question that blocks a task goes on that task (`task_update` state
   blocked). Next step is at most 3 lines that point at task refs (hos refuses a longer list). hos writes the
   `Tasks d/n done · next …` line in State itself. History holds the long story; Log holds one line.
6. **Write.**
   - Inside hos: `progress_update {folder?, sections?, revs?, close?, add_open?, note}` with only the changed
     sections, the `rev` you read for each, `close`/`add_open` for Open items, and a one-line `note`. hos stamps
     State, writes the Log line and commits. A stale rev comes back with the current text: merge it and retry once.
     Never edit PROGRESS.md with Write/Edit inside hos.
   - Outside hos: one anchored edit per section (from its `## ` heading to the next heading), then add the Log line
     at the top of Log: `YYYY-MM-DD HH:MM <zone> · <session> · <sections> · <note>`; keep 20 lines. Update State's
     `As of` line yourself. Time and zone come from the time zone hos is configured with (`owner.timezone` in
     `hos/policy.yaml`, else the system zone): `TZ=<that zone> date '+%F %H:%M %Z'`.
7. **Check.** Every required heading is there, `- Path:` and `- Branch:` in Where still exist, no `<!-- fill` left in
   sections you touched.

## Handoff mode

Called by the handoff skill in continue mode: do Update with the handoff sections, make Next step the single first
action for a cold successor, then return to the handoff skill: it writes `handoff-gen<N>.md` beside this file and
calls `handoff_ready` with that file's path (hos validates both).

## Resuming (what a successor does)

Read PROGRESS.md → `git log` on the Where branch → open tasks → run Checks → do Next step. A broken
Check is fixed before any new work.
