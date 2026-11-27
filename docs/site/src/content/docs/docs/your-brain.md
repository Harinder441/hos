---
title: Your brain
description: What is in your brain, why it is a private repo you own and not a fork, and how starter updates merge.
---

Your brain is a git repo of your rules, profiles, skills and notes. Every hos chat gets it, whatever repo it is
working on, so they all follow the same rules and leave their progress in the same place.

## What is in it

| Path | What it holds | Who edits it |
|---|---|---|
| `AGENTS.md` | The rules every agent follows | starter, then you |
| `CLAUDE.md` | Three lines that import the rules for Claude | starter |
| `profiles/<id>/` | One folder per profile: what the chat does, its rules, its memory | you |
| `shared/USER.md` | Who you are: name, timezone, how you like answers | you |
| `shared/MEMORY.md` | Decisions that hold for every profile | you and your chats |
| `shared/LOCATIONS.md` | Where your repos and folders live | you |
| `.claude/skills/` | Skills: the starter's, the ones hos copies in (including the `hos` skill and its recipes), and yours | starter, hos, you |
| `hos/*.yaml` | Approvals policy, actions, schedules, workspace rules | you, with approval |
| `work/` | One folder per piece of work, each with a `PROGRESS.md` | your chats |
| `history/` | One file per day: asked, did, wrote, open | hos and your chats |
| `learn/` | Lesson templates for when a chat teaches you something | starter, you |
| `diagrams/` | Boards your chats draw on | your chats |

hos commits what each chat wrote, one commit per chat per turn. When the brain has an `origin` and is on `main`,
hos merges `origin/main` and pushes on its own, never forcing. A merge conflict pauses pushing until you resolve it.

## Why a private repo you own, not a fork

Your brain will hold your notes and rules, so it must be private. On GitHub a fork of a public repo is always
public, and a "use this template" copy shares no history, so later starter updates cannot merge.

So the install clones `hos-brain` with the remote named `starter` and disables pushing to it (`hos init --adopt`),
then your agent pushes your copy to a new private repo you own, which becomes `origin`. Your commits sit on top of
the starter's, which is what lets updates merge.

```sh
git -C ~/hos-brain remote -v
# origin   git@github.com:<you>/hos-brain.git (fetch and push, private)
# starter  https://github.com/Harinder441/hos-brain (fetch; push DISABLED)
```

## Updates merge cleanly by design

The starter never changes the files that are yours after its first release: `shared/USER.md`, `shared/MEMORY.md`,
and every profile's `RULES.md` and `MEMORY.md`. Starter text lives in `AGENTS.md`, profiles' instructions and skills.
When a starter release has a line worth adding to one of your files, its notes say "copy this line if you want it".

To update:

```sh
hos brain update      # fetch the starter, list its new commits, merge, sync the hos-owned skills, validate
```

It refuses to start while the brain has uncommitted changes. If a file conflicts, your agent walks you through it
file by file (the hos skill's [Update from the starter](../make-it-yours/#update-from-starter) recipe). It never
takes the starter's version wholesale.

## Rules and memory

- **Rules** are corrections that should hold from now on. They go in a profile's `RULES.md`, one numbered line each,
  never renumbered, so you can say "that breaks R12".
- **Memory** is a decision still in force. One line each in `MEMORY.md`.
- Keep what your agents learn in these files rather than in an agent's own built-in memory, so it is something you
  can read, diff and revert.
