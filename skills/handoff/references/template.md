# Handoff template

Copy the skeleton below and replace every `<UPPER_CASE>` placeholder; the scrub step greps
for any left behind.

## Section rules

- **Goal**: the outcome in 1–2 sentences, not the activity.
- **Target**: absolute path and branch exactly as `ls` / `git branch --show-current` printed
  them at write time.
- **Files you own / Leave alone**: absolute paths or globs. Owned files are the only ones the
  receiver edits.
- **Locked decisions**: each with its one-line reason. The receiver treats them as fixed.
- **Copy this precedent**: the sibling's absolute path plus what to mirror, with one concrete
  name mapping (e.g. `billing/InvoiceController.ts` → `orders/OrderController.ts`).
- **New flags, env vars, fields**: each names the requirement it serves; one without a
  requirement is cut. Delete the section when there are none.
- **Waits for**: files other agents will produce, with what to do until they exist. Write
  `None` when nothing.
- **Done means**: checkable conditions (a command and its expected result, a file that
  exists), so the receiver can tell done from not-done.
- **Receiver is a lead** (profile `lead`): work it hands on is named "chats" (`fresh-chat` / `spawn`), not subagents.
- **State so far / Tried / Next step**: continue mode only; delete all three in delegate
  mode. Next step is the single first action, concrete enough to start cold.

## Skeleton

```markdown
# Handoff: <TITLE>

Mode: <MODE> · Written <DATE>

## Goal

<GOAL>

## Target

- Path: `<ABS_PATH>`
- Branch: `<BRANCH>`
- Before editing, run `git -C <ABS_PATH> branch --show-current`; if it differs from the
  branch above, stop and report.

## Files you own

- `<OWNED_PATH>` — <WHAT_TO_DO_THERE>

## Leave alone

- `<UNTOUCHED_PATH>` — <WHY>

## Locked decisions

- <DECISION> — <REASON>

## Copy this precedent

- `<PRECEDENT_PATH>` — mirror <WHAT_TO_MIRROR>. Names follow it: <NAME_MAPPING>.

## New flags, env vars, fields

- `<NEW_NAME>` — serves: <REQUIREMENT>

## Git policy

<GIT_POLICY>

## Waits for

- `<WAIT_PATH>` from <PRODUCER> — <UNTIL_THEN>

## Done means

- <CHECKABLE_CONDITION>

## Report back

Reply with: files changed (absolute paths), commands run with the last lines of their
output, and open items numbered F1, F2, ….

## State so far

<STATE>

## Tried

- <ATTEMPT> — <OUTCOME>

## Next step

<NEXT_STEP>
```
