---
id: update-from-starter
title: Update from the starter
kind: brain
size: S
hos: ">=0.1"
source:
  - src/cli/brain-update.ts
  - src/cli/validate.ts
  - src/cli/skills.ts
  - src/brain-commits.ts
docs: make-it-yours#update-from-starter
---

# Update from the starter

Your brain began as a copy of the public starter brain, kept as a git remote named `starter`. When the starter
releases improvements (better shared rules, new profiles, fixed skills), you merge them into your brain. Your own
commits stay on top; nothing of yours is replaced without you seeing it.

The starter never changes the files that are yours after its first release: `shared/USER.md`, `shared/MEMORY.md`,
and every profile's `RULES.md` and `MEMORY.md`. When a release has a line worth adding to one of those, its notes say
"copy this line if you want it". So most updates merge with no conflict.

**What you get:** the starter's new commits merged into your brain, the hos-owned skills refreshed, a check that
everything still loads.

**Ask your agent:** "Use the hos skill to update my brain from the starter."

---

## For the agent

### Ask the user (once, before merging)

1. Show what is new: `git fetch starter` then `git log --oneline --no-merges HEAD..starter/main` (use the starter's
   default branch if it isn't `main`), with the release notes if the starter has them. Ask: (a) merge now (default)
   or (b) not now.

### Steps

1. Check the brain is clean: `git status --porcelain`. If anything is listed, stop (the command refuses a dirty
   tree): a chat may be mid-turn, and hos commits at the end of each turn. Ask the user to wait or to say what those
   changes are.
2. Merge: `hos brain update --brain .`. It fetches `starter`, lists the new commits, merges, then runs
   `hos skills sync` and `hos validate`. On conflicts it lists the files and stops, mid-merge.
3. For each conflicted file, one at a time with the user:
   - Show both sides in plain words: what the user has, what the starter changed, and why (from its commit message).
   - User-owned files (`shared/USER.md`, `shared/MEMORY.md`, `profiles/*/RULES.md`, `profiles/*/MEMORY.md`): keep
     the user's text. Offer the starter's new lines one by one.
   - `AGENTS.md`, profiles, skills, `hos/*.yaml`: combine both, keeping every edit the user made. Ask when the two
     really disagree.
   - Rule numbers: if the starter added a rule with a number the user already uses, keep the user's rule as it is
     and give the starter's rule the next free number (recipe `turn-a-correction-into-a-rule`).
   - Edit the file, then check it as its own step: `rg -n '^(<<<<<<<|=======|>>>>>>>)' <file>` finds nothing. Then
     `git add <file>`.
4. When no file is left (`git diff --name-only --diff-filter=U` is empty), ask the user, then finish the merge with
   `git merge --continue`. This is the one commit made by hand in the brain: hos doesn't commit while a merge is
   open.
5. If the merge finished in step 4, run the steps the command skipped: `hos skills sync --brain .`, then
   `hos validate --brain .`. Files the sync changed are committed by hos at the end of the turn.

### Check

`git log --oneline -3` shows the merge on top. `hos validate` passes. `hos skills sync` reports what it refreshed;
show the user any skill it reports "edited, not updated" and ask whether to keep their copy.

### If it fails

- "this brain has no starter remote": the brain wasn't made by the installer. Ask the user for the starter's URL,
  then `git remote add starter <url>` and `git remote set-url --push starter DISABLED`, and start again.
- "a merge is already in progress": an earlier update stopped mid-merge. Go on from step 3, or `git merge --abort`.
- "refusing to merge unrelated histories": the brain was made from a template copy, not a clone. Stop and explain;
  don't use `--allow-unrelated-histories` without the user, since every shared file would conflict.
- `hos validate` fails after the merge: a starter change needs a matching edit in the user's files. Fix the line it
  names, with the user.

### Undo

Mid-merge: `git merge --abort` puts everything back. After the merge commit: `git revert -m 1 <merge commit>`, with
the user's OK. Never reset or force-push `main`.

### Don't

- Never take the starter's side of a whole file (`git checkout --theirs`, `-X theirs`), and never overwrite a
  user-owned file with the starter's copy.
- Never renumber rules to make room for the starter's.
- Never push to `starter`, and never rewrite the brain's history.
