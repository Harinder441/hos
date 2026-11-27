# Sample brief

The shape a `fresh-chat` brief follows. The repo, paths and items below are made up; copy the structure, not the
content. Every path in a real brief is absolute (written `~/…` here for short) and was checked with `ls` when the brief was written.

```markdown
# Build brief: retry failed webhook deliveries

Mode: delegate · Written 2026-03-04

## Goal

Failed webhook deliveries are retried 3 times with backoff instead of being dropped after the first failure.

## Setup

- Repo: `~/code/api`
- Worktree: `~/code/api-worktrees/webhook-retry`, branch `feat/webhook-retry`, cut from `main`
- Before editing, run `git -C ~/code/api-worktrees/webhook-retry branch --show-current`; if it is not
  `feat/webhook-retry`, stop and report.

## Do this

1. `src/webhooks/deliver.ts:42` — wrap the POST in `withRetry` (3 tries, 1 s / 4 s / 16 s). Test: a new case in
   `src/webhooks/deliver.test.ts` where the first two calls fail and the third succeeds.
2. `src/webhooks/deliver.ts:67` — after the last failed try, write the delivery to the `failed_webhooks` table.
   Test: a case where all three tries fail and one row is written.
3. `src/lib/retry.ts` — new `withRetry(fn, delaysMs)`, copied from the pattern in `src/lib/poll.ts`. Test:
   `src/lib/retry.test.ts`, delays checked with fake timers.

## Not in scope

- The admin page that lists failed webhooks.
- Changing the webhook payload or its signature.

## Checks

- `npx vitest run src/webhooks/deliver.test.ts src/lib/retry.test.ts` → all pass (touched test files only).
- `npx tsc --noEmit` → no errors.
- Repro before → after: `npm run repro:webhook-500` drops the delivery before the change and retries 3 times after.

## Ship

- One commit per item, message `webhooks: <what>`. The user approved commits on this branch: "commit as you go on
  the retry branch".
- Push the branch and open a PR against `main`. The user approved this: "open the PR when the checks pass".
- Don't merge.

## Report

Write `<WORK_DIR>/2026-03-04-REPORT-webhook-retry.md`: each item done / stopped / skipped with the reason, the
commands run with the last lines of their output, the PR link, and open questions numbered Q1, Q2, ….
Update PROGRESS.md via `progress_update` before `complete`.
```

In a real brief, `<WORK_DIR>` is replaced by the absolute work folder path.
