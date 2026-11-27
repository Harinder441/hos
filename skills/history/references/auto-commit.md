# How the brain gets committed

Two committers, never both for one turn:

- **Inside hos** (the chat has `HOS_CHAT=1` in its environment): hos commits brain files itself, as chats touch them
  and in periodic sweeps, with the same guards as the hook below (files > 5 MB skipped, secret scan). It pushes, and
  another computer's brain syncs after about 5 min idle. The Stop hook exits at once.
- **Outside hos**: the brain's `Stop` hook, `.claude/hooks/auto-commit.sh`, described below. Everything here is
  `code-inferred` from the starter brain's hook; a brain with its own hook may differ, so read the script when in
  doubt.

## Contract

- Wired as the Claude Code **`Stop`** hook in `.claude/settings.json`, so it runs at the end of **every assistant
  turn**, not just at session end.
- **Always exits 0.** It never blocks or fails a turn. A missed commit is preferred to a stuck turn.
- Never forces, never rewrites history, never prints a secret value.
- Log: `$(git rev-parse --git-dir)/auto-commit.log` — inside `.git`, so per-worktree and never tracked.
- Modes: `stop` (hook, default) and `manual` (you, only when the hook failed). In `stop` mode the push is
  backgrounded; in `manual` it is synchronous.

## What it does each turn

1. **Skip inside hos**: in `stop` mode with `HOS_CHAT` set, it exits.
2. **Resolve root** from `CLAUDE_PROJECT_DIR` (or `git rev-parse --show-toplevel`); exits if not a
   work tree, and exits if `HEAD` is detached (logs `detached HEAD; skip`). Nothing changed → exits.
3. **Commit**: `git add -A`, then two guards —
   - files > 5 MB are unstaged and logged (`skipped >5MB: <path>`);
   - the staged diff is scanned for AWS access keys, GitHub tokens/PATs, `sk-` style API keys, Slack tokens,
     `BEGIN … PRIVATE KEY`, age secret keys, and DB URIs with inline credentials. On a hit the whole index is reset,
     **nothing is committed**, a notice goes to stderr, and the log records
     `ABORT: secret-like content staged on <branch>; nothing committed`. Only the pattern class is logged, never the value.
   - Commit message: `brain: <YYYY-MM-DD HH:MM> · <branch> · <N> file(s)`, with the first 10 file names in the body.
4. **Push** `origin <branch>` when the branch has an upstream, best-effort. Logs `pushed <branch>` or
   `push failed (offline or not a fast-forward)`.

Net effect: a history entry written before the final message is committed on the current branch and pushed when an
upstream exists — with no manual git.

## Why manual commits are forbidden

- The hook (or hos) already commits everything; a hand commit only changes *who* made it.
- Hand commits (especially `--amend`, `reset`, or committing on `main` from a worktree) can leave the
  branch not fast-forwardable, so pushes start failing and history stops reaching the remote.
- Two workspaces or computers may be active at once; merging their day files depends on linear branch history.

The brain-level rule lives in `AGENTS.md`: never `git commit` in the brain by hand.

## Diagnosing a failure

```bash
tail -20 "$(git rev-parse --git-dir)/auto-commit.log"    # what the hook did last
git status --porcelain                                   # anything left uncommitted?
git log --oneline -5                                     # expect `brain: …` commits
git log --oneline -3 origin/<branch>                     # did it reach the remote?
bash .claude/hooks/auto-commit.sh manual                 # force commit + push now
```

| Log line | Meaning | Action |
|---|---|---|
| `ABORT: secret-like content staged` | A staged file matched a secret pattern; **nothing** in the turn was committed | Redact / move the value out of the brain; next turn commits |
| `skipped >5MB: <path>` | File too large; everything else committed | Move it under the work folder's `raw/` (ignored) |
| `commit failed` | git refused the commit (hooks, identity, lock file) | Read the lines above it in the log; fix the cause, then `manual` |
| `push failed (offline or not a fast-forward)` | No network or the remote moved | Offline: ignore, retried next turn. Remote moved: tell the user (merging must keep **both** sides of any day file); never force-push |
| nothing in the log at all | Hook not firing — settings not loaded or workspace trust not accepted (`unverified`) | Check `jq '.hooks' .claude/settings.json`; accept the trust prompt once, then retry |
