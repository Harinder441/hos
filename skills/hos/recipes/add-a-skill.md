---
id: add-a-skill
title: Add a skill
kind: brain
size: S
hos: ">=0.1"
source:
  - src/skills.ts
  - src/profiles.ts
  - src/policy.ts
  - src/cli/validate.ts
  - src/cli/skills.ts
docs: make-it-yours#add-a-skill
---

# Add a skill

A skill is a folder with a `SKILL.md` that teaches an agent one kind of task: how you review code, how you write a
weekly summary, how to deploy one of your apps. The agent loads it when your request matches its description.

Skills you put in your brain's `.claude/skills/` reach every hos chat, and plain Claude Code opened in the brain
folder too. Write your own, or install one someone else wrote after reading it.

**What you get:** a folder `.claude/skills/<name>/`, the skill in the `/` menu of the profiles that should see it, no
restart.

**Ask your agent:** "Use the hos skill to add a skill that <does what, when I say what>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **What the skill does**, and the phrases that should trigger it ("when I say 'weekly summary'"). This becomes
   `description`, which decides when the agent loads it, so name the triggers and when *not* to use it.
2. **Write or install?** (a) write a new one from the user's steps (default), or (b) install an existing folder or
   repo the user names.
3. **name**: lowercase with `-`. Default: two or three words from answer 1. It must not exist in `.claude/skills/`.
4. **Which profiles see it.** Profiles with no `skills:` key (or `skills: all`) get it on their own. List the profiles
   that have a `skills:` list and ask which of those should get it. Default: none of them.

### Steps

1. Check the name is free: `ls .claude/skills/`. Also check the user's personal `~/.claude/skills/`: a brain skill
   with the same name replaces it in hos chats. Never reuse the name of a hos-owned skill (the folders whose files
   `.claude/skills/.hos-managed.json` lists).
2. (a) Write `.claude/skills/<name>/SKILL.md`:

   ```markdown
   ---
   name: <name>
   description: <what it does>. Use when <trigger phrases>. Do NOT use for <near misses>.
   ---
   # <Title>

   <numbered steps the agent follows; what it reads, what it writes, how it checks the result>
   ```

   Keep it short. Long reference material goes in files beside `SKILL.md` that the steps point to.
3. (b) Copy the folder into `.claude/skills/<name>/`. Read every file first and show the user any script it runs:
   scripts run with the user's rights. Stop if it reads secrets or sends data somewhere the user didn't expect.
4. For each profile from answer 4, add `<name>` to its `skills:` list in `profiles/<id>/PROFILE.md`. Never add a
   `skills:` list to `generic`.

### Check

```sh
hos validate --brain .          # every name in a profile's skills: list is an installed skill
```

Then ask the user to open a chat with one of those profiles, type `/` and find the skill, then say one trigger
phrase and see the agent load it.

### If it fails

- `skills: "<name>" is not installed in .claude/skills`: hos reads the frontmatter `name`, else the folder name.
  Make them the same. "is a hos skill that is not in .claude/skills yet" means: run `hos skills sync --brain .`.
- Not in the `/` menu: the profile's `skills:` list lacks it, or `skills.hide` in `hos/policy.yaml` hides it from new
  chats.
- The agent never loads it: the `description` is too vague. Put the user's exact trigger phrases in it.

### Undo

Delete `.claude/skills/<name>/` and remove `<name>` from every `skills:` list (else `hos validate` fails).

### Don't

- Don't edit a hos-owned skill to change it. `hos skills sync` keeps an edited file but stops updating it ("edited,
  not updated"). Copy it under a new name instead.
- Don't put secrets, tokens or personal data in a skill. A skill that needs a secret reads it at run time through
  the brain's `scripts/secret.sh <NAME>`.
- Don't install a skill whose scripts you haven't read.
