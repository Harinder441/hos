---
id: turn-a-correction-into-a-rule
title: Turn a correction into a rule
kind: brain
size: S
hos: ">=0.1"
source:
  - src/profiles.ts
  - src/cli/validate.ts
docs: make-it-yours#turn-a-correction-into-a-rule
---

# Turn a correction into a rule

When you correct an agent and want it to hold from now on ("don't run the whole test suite after every edit"), make
it a rule. A rule is one numbered line in a file every chat of that profile reads at the start, so the next chat
already knows.

Rule numbers are shared across the brain and never change, so "that breaks R14" means the same thing in every chat
and every profile.

**What you get:** one new line `- R<n> ...` in a profile's `RULES.md`, or in `AGENTS.md` for every profile. New chats
follow it; no restart.

**Ask your agent:** "Use the hos skill to make this a rule: <the correction>." Or, right after a correction:
"Make that a rule."

---

## For the agent

### Where it goes

- One profile's behaviour → `profiles/<id>/RULES.md`.
- Every profile → the `## Rules` list in `AGENTS.md`.
- A decision or fact, not a behaviour ("we use pnpm in the api repo") → not a rule: `shared/MEMORY.md`, or the
  profile's `MEMORY.md` when only one profile needs it.
- How to do one kind of task (a review style, a deploy) → that task's skill, not a rule.

### Ask the user (once, all together, defaults shown)

1. **The rule**, in one line, as an instruction. Draft it from the correction and show it: short, plain, one idea.
2. **Which profiles**: (a) the profile of the chat that was corrected (default), (b) several named profiles, or (c)
   every profile (`AGENTS.md`).

### Steps

1. Find the next free number across all rule files:

   ```sh
   rg -o --no-filename '^- R[0-9]+' AGENTS.md profiles/*/RULES.md | sort -t R -k2 -n | tail -1
   ```

   The new rule takes that number plus one.
2. Check the rule isn't there already under another number: `rg -i '<key words>' AGENTS.md profiles/*/RULES.md`.
   If one says nearly the same, offer to sharpen that line in place instead, keeping its number.
3. Append `- R<n> <the rule>` to the end of the list in each file from answer 2. The same rule in several profiles
   keeps the same number in each.
4. If the new rule contradicts an older one, show both and ask which wins. Edit the older line's text in place if
   the user wants; never delete a number to reuse it.

### Check

```sh
hos validate --brain .          # the profile still loads with all four identity files
rg -n '^- R<n> ' AGENTS.md profiles/*/RULES.md
```

New chats of that profile read the rule at their start. Tell the user it applies from the next chat; in the current
chat, follow it from now on yourself.

### If it fails

- Two rules got the same number: renumber only the one you just added, before anyone refers to it.
- The chat still ignores it: the line is too long or mixes two ideas. Split it, each with its own number.

### Undo

Delete the line. Its number stays retired; the next rule takes the next free number.

### Don't

- Never renumber or reorder existing rules, and never fill a gap in the numbers.
- Don't add a rule the user didn't confirm, and don't widen one beyond what they said.
- Don't put rules in `SOUL.md`, `USER.md` or `MEMORY.md`.
- Don't give `generic` a rule that takes away a feature or tool ("never edit code"); make a narrower profile instead
  (recipe `create-a-profile`).
