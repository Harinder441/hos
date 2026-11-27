---
id: change-hos
title: Change hos
kind: code
size: M
hos: ">=0.1"
source:
  - CLAUDE.md
  - GLOSSARY.md
  - docs/adr/0003-test-seam-daemon-boundary.md
  - src/main.ts
  - src/launchd.ts
  - src/fakes/scripted-agent-runtime.ts
  - scripts/check.mjs
  - scripts/full-suite-lock.mjs
  - playwright.config.ts
docs: extend-hos#change-hos
---

# Change hos

Fix a bug in hos or add a small feature, with your agent doing the work. It reads the docs and code of the hos
version you run, reproduces the bug first, changes the code, a test and the docs together, and opens a pull request
to your own fork. It works in a separate copy of the code, so the hos you are using keeps running.

It never merges, never restarts your hos and never touches your hos data. When the pull request is merged, you
rebuild and restart hos yourself (one line, below).

Use the brain recipes instead for changes to your own setup (approvals, actions, schedules, profiles). Those are
files in your brain, not hos code.

**What you get:** a branch and a pull request to your fork: the code, a test that failed before and passes now, and
the docs page that describes the behaviour.

**Ask your agent:** "Use the hos skill: hos does <X> wrong" or "make hos do <Y>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **What is wrong or wanted**, with an example: what they did, what they saw, what they expected. A pasted error
   or Doctor row is enough.
2. **The hos checkout**: the `hos` key in `shared/LOCATIONS.md`. If it is missing, ask for the path. If there is no
   checkout, offer to clone their fork at the version `hos --version` prints, and add the `hos` row.
3. **Base branch**: default the checkout's default branch.
4. **A PR upstream too?** Default: no, only to their fork.

### Steps

1. **Classify.** A question: answer from the docs page plus `file:line`, then stop. A config change: use the brain
   recipe for it and `hos validate`. A data source or harness from the brain: recipes `add-a-data-source`,
   `add-a-harness`. A transport or setting: recipes `add-a-transport`, `add-a-setting`, which return here. A bug or
   feature: go on.
2. **Pin.** Print `hos --version` (`hos <version> (<commit>)`) and the checkout's `git rev-parse --short HEAD` and
   `package.json` version. If they differ, say so and say which one the change targets. Default: the base branch,
   not the running commit, unless the user asks.
3. **Read**, in the checkout, in this order: `CLAUDE.md` (its rules win over this recipe), the docs in
   `docs/site/src/content/docs/`, the recipe's or page's `source:` files, `GLOSSARY.md`, the related `docs/adr/`,
   then search `src/` and `web/src/`. Write down `file:line` for the behaviour and for the test that covers it
   (`test/<area>.test.ts`, `e2e/<area>.spec.ts`).
4. **Worktree.** Make a new worktree on a branch `change-hos/<slug>`, never in the checkout the daemon runs from.
   Inside hos, use `workspace_create` with the repo and that branch (if the topic doesn't use the repo yet,
   `workspace_choose` lets the user pick it). Outside hos, use `git worktree add`. Then run `npm ci` in the worktree.
5. **Reproduce (bugs).** Make it fail first: a Vitest test at the daemon seam (ADR 0003), an e2e step, or a step on
   the throwaway daemon below. If you can't make it fail, report "not reproduced" with what you tried, and stop.
6. **Plan.** Anything bigger than one obvious line: list the files, the test and the docs page, then wait. Inside
   hos use `propose_plan`; outside, end the turn with the plan.
7. **Change** the code, the test and the docs page in the same diff, including any `source:` list that names a file
   you moved.
8. **Test**, tiered as `CLAUDE.md` says:
   - while working: `npm run check -- <areas>` (`--list` shows what it picks);
   - if `web/` or an HTTP route changed: `npm run check:e2e -- <areas>`, with a `HOS_E2E_PORT` no other worktree
     uses;
   - once, at the end: `npm run test:full`. Inside hos, hold the `hos-full-suite` lock (`lock`) while it runs.
     A test that passes only on retry is a snag: report it.
   - live tests only when the user asks: they spend the user's real subscription.
9. **Deliver.** Commit on the branch, push it to the user's `origin` (their fork), and open a PR to the fork's
   default branch with `gh pr create`. Offer an upstream PR only if answer 4 says so. If a snag started this, link
   it and resolve it with the commit once the user merges.

**Throwaway daemon** for a behaviour check, built from the worktree (`npm run build`), all data in temp folders:

```sh
T="$(mktemp -d)"; mkdir -p "$T/data" "$T/empty"
git init -q "$T/brain" && git -C "$T/brain" commit -q --allow-empty -m init
node dist/daemon/main.js --agent scripted --data-dir "$T/data" --brain "$T/brain" \
  --repo-root "$T/empty" --worktree-root "$T/empty" --tmux-socket "$T/tmux.sock" \
  --gh-bin test/fixtures/bin/fake-gh.mjs --port <free port>
```

`playwright.config.ts` starts hos the same way; copy any fake it sets. Open `http://localhost:<port>`, add a passkey
with the enrolment code it prints, and drive chats with the scripted commands (`write <name>`, `spawn <role>
<intent>`, `ask`, `plan <title>`, `briefing` …, listed in `src/fakes/scripted-agent-runtime.ts`). Stop it with
Ctrl-C and delete `$T`.

### Check

Report: the page and sentence that describe the behaviour, the files changed, the test that went from failing to
passing, the check results, and the PR link. Then the line for the user: "To run it: merge, then
`npm run build && hos keeper restart` in your hos checkout."

### If it fails

- `npm run check` picks no test for a file: pass area names (`npm run check -- <area>`).
- The full suite waits: another worktree holds `hos-full-suite`. Wait; don't take it from them.
- The change needs a new config key: that's recipe `add-a-setting`.

### Undo

Close the PR and delete the branch and the worktree. Nothing else changed.

### Don't

- Don't write under the hos data dir (`--data-dir`, default `~/.hos`: the database, push keys, passkeys, enrolment
  code, backups, the Config vault). Read it only through the HTTP API or the Doctor.
- Don't read, print, move or create secrets: Keychain items, sign-in tokens, the brain's `scripts/secret.sh` values,
  `.env*` files.
- Don't restart, stop or rebuild the running daemon, or run `npm run build` in the live checkout, without the user's
  yes in this chat.
- Don't push to any `main` or default branch, force-push, `npm publish`, tag a release or merge your own PR.
- Don't install software or change machine settings (launchd, systemd, Tailscale, Cloudflare, `pmset`). List them as
  `[user]` steps.
- Don't let tests touch the user's real repos, tmux server, Keychain or subscriptions: temp folders, a separate tmux
  socket and the injected fakes only.
- Don't edit the brain's `hos/*.yaml` or profiles as part of a code change. That is a separate brain edit.
- Don't weaken a safety default (approvals, loopback-only, passkeys, the kill switch) without saying so in the PR's
  first line.
