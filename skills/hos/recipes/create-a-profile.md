---
id: create-a-profile
title: Create a profile
kind: brain
size: S
hos: ">=0.1"
source:
  - src/profiles.ts
  - schemas/profile.schema.json
  - src/cli/validate.ts
docs: make-it-yours#create-a-profile
---

# Create a profile

A profile is how a chat behaves: its instructions, its rules, which skills it sees, which model it uses. You pick it
when you start a chat. Every brain starts with `generic`, which can use every hos feature and tool, so you can try
everything before you decide what a narrower profile should keep.

Make one when you notice you keep typing the same instructions at the start of a chat ("you only review, you don't
edit", "plan first, then wait"). That text belongs in a profile.

**What you get:** a folder `profiles/<id>/` in your brain, a new entry in the Profile chip, no restart.

**Ask your agent:** "Use the hos skill to create a profile for <what the chat should do>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **What the chat is for**, in one sentence. This becomes `description`, which other chats read when they pick a
   profile to spawn, so write it as a job, not a name.
2. **id**: lowercase, starts with a letter, then letters, digits or `-`, at most 40 characters. Default: a word from
   the sentence. It must not exist under `profiles/`.
3. **What it must not do** (for example "never edits code", "only writes in the work folder"). Default: nothing.
4. **Skills**: (a) all skills, like `generic` (default), or (b) only the ones listed. Show the folders in
   `.claude/skills/` to pick from.
5. **Model and effort** for its chats. Default: leave them out, so hos's default applies (as in `generic`).
6. **Spawn only?** (a) shown in the Profile chip (default) or (b) only other chats can start it.
7. **Colour** for its tab. Default: a hex colour no other `profiles/*/PROFILE.md` uses.

### Steps

1. Copy the closest existing profile as a starting point. Copying `generic` is fine; editing it is not:
   `cp -R profiles/<closest> profiles/<id>`
2. Write `profiles/<id>/PROFILE.md`. Frontmatter from the answers (leave out every key whose answer is the default),
   body = the job in a few short paragraphs: what it does each turn, what it never does, how it reports back.

   ```markdown
   ---
   description: <answer 1>
   skills: [<answer 4b>]          # omit for all
   write_scope: work_dir          # only if answer 3 limits writes to the work folder
   can_start: [<profile ids>]     # which profiles it may spawn; omit for all
   picker: false                  # only if answer 6 is (b)
   color: '<#rrggbb>'
   models:                        # only if answer 5 is not the default
     claude: { model: <model id>, effort: <effort> }
   ---
   # You are <a short role name>

   <what it does each turn, 3–6 lines>

   ## Limits

   - <answer 3, one line each>
   ```

3. With a skills list (answer 4b), also list `hos` and the other hos-owned skills the user's other narrowed
   profiles list, so its chats can still hand off, write history and run these recipes.
4. Keep `SOUL.md` and `USER.md` as copied. Reset `RULES.md` and `MEMORY.md` to their header and the paragraph under
   it: delete the `- R…` rule lines and the memory lines. Rules come later, from the user's corrections
   (recipe `turn-a-correction-into-a-rule`).
5. Hide tools only if answer 3 needs it (`hide_tools:` in the frontmatter). Never hide `complete`, `progress_read`,
   `progress_update`, `history_append` or `handoff_ready`; hos refuses a profile that does.

### Check

```sh
hos validate --brain .          # frontmatter valid, four identity files present, every listed skill installed
```

Then ask the user to open the Profile chip, pick the new profile and send one message that tests answer 3 (for
example, ask a "never edits code" profile to fix a typo). The chat should refuse or ask.

### If it fails

- `hos validate` names the field: fix that line. An unknown skill name means the skill isn't installed: drop it or
  add the skill first (recipe `add-a-skill`).
- The profile doesn't show in the chip: `picker: false` is set, or the file is broken. A broken profile is skipped
  and the hos doctor has a "Profile profiles/<id>/..." row saying why.
- A missing identity file doesn't break the profile, but its chats start without that file; the doctor lists it.

### Undo

Delete `profiles/<id>/`. Chats that ran it continue as `generic`.

### Don't

- Don't edit `generic` to make it narrower. It is the one profile that can do everything; new users rely on it.
- Don't copy the user's personal details into the profile. `shared/USER.md` already loads for every profile.
- Don't add rules the user hasn't asked for. A new profile starts with an empty `RULES.md`.
- Don't `git commit`. hos commits brain changes at the end of the turn.
