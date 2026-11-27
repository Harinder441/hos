---
name: handoff
description: >-
  Write a self-contained brief that a fresh agent runs from one pasted line. Use when
  the user says "handoff", "brief another agent", "give me a prompt for another agent",
  "write a brief for a subagent / another session", or "context is full, continue this in a
  fresh session". In a brain work folder, continue mode updates its PROGRESS.md through
  the update-progress skill and writes handoff-gen<N>.md beside it.
---

# Handoff

A handoff is a brief for a **cold** agent: it has the file, the target repo, and nothing
from this conversation. The brief is done when the receiver never has to guess: every path
is absolute and verified, every name is copied from precedent, every decision is made.

## Mode

Infer it from the ask; default `delegate`.

- `delegate`: another agent takes a scoped slice of the work.
- `continue`: this session's context is full and a fresh session takes over the same task
  ("continue in a new session", "context is full", "running out of context").

## Continue mode in a work folder

There is a work folder when the prompt has a `WORK_DIR=<dir>` line (the latest one wins), else
a non-empty `$WORK_DIR`, else (outside hos, in a brain checkout) the `work/<area>/…`
folder this session writes into. `HANDOFF_DIR` is the old name for the same folder; accept it
for now. Then the handoff is two files, both in that folder:
1. Run the `update-progress` skill in handoff mode (State, Open, Next step, Tried if anything failed).
2. Write `<dir>/handoff-gen<N>.md` with steps 2–5 below, where `<N>` is this chat's generation
   (the number in hos's ask, else 1; on a clash take the next free number). It follows the
   template like any continue brief, with the same `- Path:` and `- Branch:` lines as PROGRESS.md.
   It also names `<dir>/PROGRESS.md` and does not repeat it.

Inside hos it ends with `handoff_ready` and the handoff file's absolute path. When hos asks for
`handoff_ready` with no path, skip step 2 and call it with no path. Outside hos, report both paths and
`Read <dir>/PROGRESS.md and <dir>/handoff-gen<N>.md: run its Checks, then do its Next step.`
The steps below are for delegate briefs, for that handoff file, and for continue mode with no
work folder.

## Steps

1. **Pick the location.** A work folder (as above) → write `<dir>/BRIEF-<slug>.md`, creating
   `<dir>` if missing; it beats both defaults below. Otherwise find the root with
   `git rev-parse --show-toplevel` (cwd when not in git). Root contains `profiles/generic/SOUL.md`
   (a brain checkout) → pick the work folder by the rule in its `work/README.md` and
   write `BRIEF-<slug>.md` there. Anywhere else → `~/handoffs/<YYYY-MM-DD>-<slug>.md`.
   Handoffs never live under `~/.claude`.
   Slug: 2–4 lowercase hyphenated words; on a clash append `-2`.
2. **Resolve the target now.** `ls` the target path and run
   `git -C <path> branch --show-current`; copy both values verbatim into Target. A target
   injected in the prompt (a `TARGET=<path>` line, or a caller such as the hos bus naming the
   worktree) is the target: use it and never ask. No target path given or injected and none
   evident from the session → ask the user; a checkout is their choice.
3. **Find the precedent.** Open the closest existing sibling in the target repo (the same
   feature in another app, the adjacent module) and note its file names, layering (thin or
   fat controllers, service split), and config style. Every new name in the brief follows
   that sibling; a deliberate divergence goes in Locked decisions with its reason.
4. **Fill the template** in [`references/template.md`](references/template.md), following
   its section rules. Continue mode adds its three extra sections.
5. **Scrub.** Run `grep -nE '<[A-Z_]+>|TODO|TBD' <file>` and reread for volatile numbers
   (commits behind/ahead, line numbers, test or file counts). Resolve each placeholder or ask
   the user; swap each volatile number for the command that recomputes it. Done when the grep
   prints nothing.
6. **Report** exactly these two lines and nothing else:

   ```
   <absolute path to the file>
   Read <absolute path to the file> and do exactly what it says.
   ```

   Inside hos (delegate mode), don't hand the user that line to paste: spawn the chat yourself with the `fresh-chat`
   skill (hos `spawn`, `browser: true` for Chrome work) and report the chat instead, unless they asked for the text.

## Writing rules

- Quote decisions in full; "as discussed" means nothing to a cold agent.
- Scope by path: list the files the receiver owns and the files it leaves alone.
- State the git policy explicitly; default is no commit, no push, no branch switch.
- Keep secrets out; name the secret's source (`scripts/secret.sh <name>`, a vault key)
  instead.
