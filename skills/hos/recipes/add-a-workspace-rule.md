---
id: add-a-workspace-rule
title: Add a workspace rule
kind: brain
size: S
hos: ">=0.1"
source:
  - src/picker.ts
  - src/workspaces.ts
  - src/actions.ts
  - schemas/actions.schema.json
docs: make-it-yours#add-a-workspace-rule
---

# Add a workspace rule

When a chat needs to work in one of your repos, hos asks you which checkout to use: the main one, or a new worktree
on its own branch. A workspace rule answers that for a repo once, so you stop being asked. It can also say which
branch new worktrees start from, when your pull requests go somewhere other than GitHub's default branch.

The setup step that runs when a new workspace is created lives next to it. By default it copies your `.env*` files
from the main checkout into the new worktree.

**What you get:** a rule in `hos/workspace-rules.yaml` and, if you want, a changed `setup:` block in
`hos/actions.yaml`, no restart.

**Ask your agent:** "Use the hos skill to add a workspace rule for <repo>: <what you want>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **Which repo**: its key in `shared/LOCATIONS.md`, or its folder name.
2. **Which checkout**: (a) ask each time (default: no `use`), (b) always the main checkout (`use: root`), or (c)
   always a worktree on one branch (`use: branch:<name>`).
3. **Base branch** for new worktrees. Default: GitHub's default branch (no `base`).
4. **Why**, in one line. This is `reason`, shown to the chat instead of the question.
5. **Setup step**: (a) keep it (default), (b) change what it runs for every repo, or (c) don't run it for this repo
   (`skip`).

### Steps

1. Add the rule to `rules:` in `hos/workspace-rules.yaml` (replace `rules: []` if the list is empty):

   ```yaml
   rules:
     - repo: <answer 1>
       use: <root | branch:<name>>   # omit for answer 2a
       base: <branch>                # omit for the default
       reason: <answer 4>
   ```

   A rule needs `use` or `base`; with neither, hos ignores it. One rule per repo: hos uses the first that matches.
2. For answer 5b, change the `setup:` block in `hos/actions.yaml`:

   ```yaml
   setup:
     run: bash "$HOS_BRAIN/scripts/workspace-setup.sh"   # a command, or a script path relative to the brain
     does: <one line saying what it does>
     skip: []                                            # repo names where setup must not run
   ```

   The command runs in the new workspace with `HOS_WORKSPACE_PATH`, `HOS_ROOT_PATH` (the main checkout),
   `HOS_REPO`, `HOS_BRANCH`, `HOS_BASE` and `HOS_BRAIN` set. It must exit 0 within 5 minutes. Edit the script in
   the brain's `scripts/` rather than putting long commands in `run`.
3. For answer 5c, add the repo name to `skip:`; its workspaces start ready.

### Check

```sh
hos validate --brain .          # hos/actions.yaml matches the schema; hos/workspace-rules.yaml is valid YAML
```

Ask the user to open Settings, Workspace rules: the rule shows with its reason. Then start a chat and ask it to work
in that repo: with `use`, it says "brain rule: <reason>" and no picker appears. For a setup change, create a new
worktree and watch its setup mark turn ready.

### If it fails

- The picker still appears: `repo` matches neither the LOCATIONS key nor the folder name (case doesn't matter), or
  `use` isn't exactly `root` or `branch:<name>`.
- "setup failed" on a workspace: open its log from the mark, fix the script, then press Run setup again.
- A broken `hos/actions.yaml` drops the `setup:` block too; hos then falls back to copying `.env*` files.

### Undo

Delete the rule (leave `rules: []` if it was the last). Put the old `setup:` block back.

### Don't

- Don't set `use: root` on a repo where several topics edit at once; they would share one checkout.
- Don't write a setup step that overwrites files already in the worktree or prints secret values to its log.
- Don't put package installs that take minutes in setup; the 5-minute limit marks the workspace failed.
