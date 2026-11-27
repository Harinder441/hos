---
id: add-a-setting
title: Add a setting
kind: code
size: S
hos: ">=0.1"
source:
  - src/policy.ts
  - src/settings.ts
  - src/daemon.ts
  - src/cli/validate.ts
  - schemas/policy.schema.json
  - test/settings.test.ts
  - test/fixtures/policy.yaml
  - scripts/check-hover-text.mjs
docs: extend-hos#add-a-setting
---

# Add a setting

A setting is a key in your brain's `hos/policy.yaml` that hos reads, such as `composer.paste_as_file_chars`. The
Settings page lists each one with the comment written next to it in the file.

To change a value, you edit the file. To make hos understand a new key, hos's code changes: it reads the key, checks
it, shows it in Settings, and the docs mention it. Your agent does this in a new branch of your hos checkout, with a
test, and opens a pull request to your fork (the recipe `change-hos`). Without the key, hos must behave exactly as it
did before.

**What you get:** a pull request. After you merge it and restart hos, you add one line to `hos/policy.yaml`.

**Ask your agent:** "Use the hos skill to add a setting for <what it should change>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **What it changes**, in one sentence. This becomes the comment on the key, which Settings shows.
2. **Key**: snake_case, at the top level or inside a block that exists (`composer.<key>`). Default: inside the block
   of the area it changes. Check that the name is free in `src/policy.ts` and the policy schema.
3. **Type, allowed values and default.** The default must be today's behaviour.
4. **When it applies**: on the next use (hos reads the file each time) or at start (needs a restart). Default: next
   use, when that is cheap.

### Steps

Run the recipe `change-hos` steps 1–4 first (pin the version, find the checkout, make a new worktree, read). Then:

1. **Read it.** In `src/policy.ts`, add `load<Thing>(file)`, modelled on `loadComposer`: no file or no key returns a
   default constant; a wrong value throws `<file>: <key> must be …`.
2. **Use it.** Pass it from `src/daemon.ts`, where the policy file is already known as `file`.
   - Next use: hand over a function, as `composer: () => loadComposer(file)` does.
   - At start: read it once, and add the key to `RESTART` in `src/settings.ts`, so Settings marks it.
3. **Schema and validate.** Add the key with its type, range and a description to `schemas/policy.schema.json`. The
   schema refuses unknown keys, so `hos validate` says "unknown key" until this is done. Then add the new loader to
   `loaderErrors` in `src/cli/validate.ts`, so `hos validate` reports a bad value with the loader's own message.
4. **Settings.** `src/settings.ts` puts a key in a section by its top-level name: `models`, `composer`, `context`,
   `LIMITS`, `approvals` and `CONNECTION`. Any other top-level key shows under "Other". Add a new section only if the
   user asks.
5. **Comment.** Add the key to `test/fixtures/policy.yaml` with its comment on the same line, the way the other keys
   are written. That comment is the text Settings shows. Write the same line for the user to paste into their brain.
6. **A control in the app** (only if the setting needs one): every `<button>` and `<select>` in `web/src` needs a
   `title`, the hover text. `node scripts/check-hover-text.mjs` checks this.
7. **Tests** at the daemon seam (ADR 0003):
   - in `test/settings.test.ts`: `GET /api/settings` shows the key, its comment and, for a start-time key, its
     restart mark;
   - in the area's own test file: no key gives the old behaviour, a set key changes it, a bad value gives the clear
     error.
8. **Docs** in the same diff: one line on the docs page for that area (`docs/site/src/content/docs/docs/`).

### Check

```sh
npm run check -- policy settings <area>
npm run check:e2e -- settings              # only if web/ or an HTTP route changed
npm run build && node dist/daemon/main.js validate --brain <temp brain with the key>
npm run test:full                          # once, at the end, holding the hos-full-suite lock
```

Build and validate in the worktree only, never in the checkout the daemon runs from.

### If it fails

- `hos validate` says "unknown key": the schema step is missing, or the key is in the wrong block.
- The key doesn't show in Settings: the brain's file doesn't have it yet, or the key isn't under the top-level name
   that `src/settings.ts` reads.
- An existing test breaks: the default isn't today's behaviour. Fix the default, not the test.

### Undo

Before merge: close the PR and remove the worktree. After merge: delete the line from `hos/policy.yaml`; hos goes back
to the default.

### Don't

- Don't change what hos does for users who never set the key.
- Don't add a setting for a value nobody has asked to change.
- Don't put secrets in a setting. `hos/policy.yaml` is committed to the brain.
- Don't edit the user's own `hos/policy.yaml` as part of the code change. Hand them the line.
