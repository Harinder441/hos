---
id: add-an-action
title: Add an action
kind: brain
size: S
hos: ">=0.1"
source:
  - src/actions.ts
  - schemas/actions.schema.json
  - src/cli/validate.ts
docs: make-it-yours#add-an-action
---

# Add an action

An action is a command you run often in a workspace, written down once: run the tests, open a pull request, restart
the dev server, reset a local database. Each one becomes a button in the Workspaces panel and on the Actions page,
and a tool your agents can call by name instead of typing the command.

Actions live in your brain's `hos/actions.yaml` and apply to every repo, unless you limit them to some repos or
some computers.

**What you get:** an entry in `hos/actions.yaml`, a new button, no restart.

**Ask your agent:** "Use the hos skill to add an action that runs <command>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **The command**, exactly as the user types it. This becomes `run`.
2. **name**: lowercase, starts with a letter, letters, digits and `-`, at most 32 characters. Default: a verb from
   the command (`test`, `migrate`). Optional `label` is the button text (at most 60 characters).
3. **Arguments** the command takes each time (a branch, a file). Default: none. Each becomes a name in `args:`
   (lowercase letters, digits, `_`); the values are shell-quoted and added to the end of `run`, in that order.
4. **Where it runs**: (a) `host`, a plain process whose output comes back when it ends (default, for short
   commands), or (b) `tmux`, a terminal session whose output outlives the request (tests, builds, long jobs).
5. **Folder**: (a) `worktree`, the workspace it runs in (default), (b) `brain`, or (c) an absolute path.
6. **Ask before it runs?** (a) no, for commands that only read or change local files (default), or (b) yes
   (`confirm: true`) for anything that publishes, deploys, deletes or messages people.
7. **Which repos and computers.** Default: all. Else a list of LOCATIONS keys or repo folder names
   (`applies_to`), and of host names (`hosts`).

### Steps

1. Read `hos/actions.yaml`. The name must not be used by another action in it.
2. Add the action under `actions:`:

   ```yaml
     - name: <answer 2>
       label: <button text>        # optional
       run: <answer 1>
       args: [<answer 3>]          # omit for none
       where: <answer 4>
       cwd: <answer 5>
       confirm: <true | false>
       applies_to: [<repos>]       # omit for all
       hosts: [<host names>]       # omit for all
   ```

3. Every run gets `HOS_BRAIN`, `HOS_WORKTREE`, `PORT` and `HOS_PORT`, and `HOS_SERVER` when the workspace has a dev
   server session. Use them instead of hard-coded paths and ports.
4. A command longer than one line goes in a script under the brain's `scripts/`; `run` calls it with
   `bash "$HOS_BRAIN/scripts/<file>.sh"`.

### Check

```sh
hos validate --brain .          # hos/actions.yaml matches the schema
```

hos re-reads the file on every request. Ask the user to open the Workspaces panel on a workspace it applies to (or
the Actions page), find the button and run it once. An agent sees it in its `actions` tool listing.

### If it fails

- No button and an error in the panel: the file broke the schema. hos skips the whole file, so every brain action is
  gone until it is fixed. `hos validate` names the line.
- The button is missing on one workspace only: `applies_to` or `hosts` leaves it out, or the repo's own
  `.hos/actions.yaml` has an action with the same name, which wins.
- It fails at once: run the command by hand in that folder first; `cwd` may be wrong.

### Undo

Delete the entry from `hos/actions.yaml`.

### Don't

- Don't set `confirm: false` on a command that publishes, deploys or messages people. An agent calling a brain
  action without `confirm` runs it at once, with no approval card.
- Don't put a secret in `run`. A script that needs one reads it with `scripts/secret.sh <NAME>`.
- Don't add an action that only wraps a read-only command the agent can already run; it adds a button and nothing
  else.
