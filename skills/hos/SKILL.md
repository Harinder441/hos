---
name: hos
description: Change how hos works for you, from your brain or in the hos code, by following one of 15 recipes. Use when the user says "create a profile", "add a skill", "add a schedule", "run this every morning", "add an action", "add a workspace rule", "change approvals", "stop asking me before X", "tell hos where my repos are", "set up phone access", "remember this rule", "update from the starter", "add a data source", "connect my task app / calendar", "add a harness", "use another agent", "add a transport", "add a setting", "change hos", "fix this hos bug", "hos does X wrong", or pastes a hos error or doctor row. Not for work in another repo (work-in) or for a question the docs answer outright.
---

# hos — recipes for changing hos

hos copies this skill into your brain (`hos init`, `hos skills sync`), so it matches the hos version you run. It works
in a hos chat and in any agent opened in the brain folder, so it also helps when hos itself is down.

## 1. Pin the version

Run `hos --version` (if `hos` is not on `PATH`: `node <hos checkout>/dist/daemon/main.js --version`; the checkout is the
`hos` row in `shared/LOCATIONS.md`, else ask the user). Say the version in your first line.

## 2. Pick the recipe

Classify the ask, then open the one file in `recipes/` that fits. Read its frontmatter first.

| Ask | Recipe | Kind |
|---|---|---|
| A new kind of chat with its own instructions, skills, model | `create-a-profile` | brain |
| Write or install a skill, give it to profiles | `add-a-skill` | brain |
| Something that runs on a timetable | `add-a-schedule` | brain |
| A named command on a button in the UI | `add-an-action` | brain |
| Which repos a topic attaches, the script a new worktree runs | `add-a-workspace-rule` | brain |
| Ask before / stop asking before / never allow a kind of action | `change-approvals` | brain |
| Where your code lives | `add-repo-locations` | brain |
| Reach hos from a phone or another computer | `set-up-phone-access` | brain |
| A correction that should become a lasting rule | `turn-a-correction-into-a-rule` | brain |
| Take in a new starter release | `update-from-starter` | brain |
| Feed Home's tasks, capture box, calendar or snags from another system | `add-a-data-source` | code |
| Run another coding agent in hos | `add-a-harness` | code |
| A new way to reach hos from other devices | `add-a-transport` | code |
| A new key in `hos/policy.yaml` | `add-a-setting` | code |
| A hos bug, a small feature, "why does hos do X" | `change-hos` | code |

- A question the docs or a recipe's top part answers: answer it with the file and stop.
- Nothing fits: say so, name the nearest recipe, and ask before improvising. A change to hos code with no recipe goes
  through `change-hos`.

## 3. Check the recipe fits this hos

The recipe's `hos:` range must include the version from step 1. If it does not, tell the user to run
`hos skills sync` (it refreshes this skill to the running version) and stop. Code recipes also need a hos source
checkout at the same version: compare `git -C <checkout> describe --tags` with step 1 and say if they differ.

## 4. Follow it

- Do the recipe's `## For the agent` part in order: ask its questions once, all together, with the defaults shown;
  run every **Check**; on a failed check use its **If it fails** line, then stop and show the output.
- Brain recipes end with `hos validate` passing. Code recipes end with the repo's checks and a PR to the user's fork.
- Finish with what changed (files), how to undo it (the recipe's **Undo**), and anything only the user can do as a
  `[user]` item.

## Limits

- Edits under the brain's `shared/`, `profiles/`, `.claude/`, `hos/`, `CLAUDE.md` and `AGENTS.md` are brain config:
  hos's approvals decide whether they ask. Plug-in files in `hos/plugins/` and the `plugins:` list always ask.
- Never write in hos's data folder (`~/.hos` by default), never print a secret, never restart or rebuild the running
  hos without the user's yes in this chat.
- Never push to a default branch, force-push, publish a package or merge your own PR.
- Never narrow the `generic` profile; it is the one that can use everything.
