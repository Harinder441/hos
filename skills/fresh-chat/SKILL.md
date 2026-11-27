---
name: fresh-chat
description: Hand a piece of work to 1–N fresh hos chats in this topic from one line — write the brief into the work folder, then spawn the chats with a one-line prompt that points at it. Use when the user types /fresh-chat or /fresh-chat 3, or says "start a fresh chat for this", "spawn a chat to build it", "give this to a new chat", "write one prompt and start a chat", "hand this to 3 chats". NOT for continuing this chat's own work in a successor (restart), for a brief the user pastes by hand or outside hos (handoff), or for work your own subagents can do in this turn.
---

# Fresh chat

Argument: N, the number of chats (default 1). Words like a harness name, a model, a worktree or an extra rule are
spawn options.

1. **Brief.** Write the full task with the `handoff` skill in delegate mode (skip its two-line report) to `$WORK_DIR/<YYYY-MM-DD>-BRIEF-<slug>.md`.
   The model is [`references/sample-brief.md`](references/sample-brief.md):
   - what to do and nothing else; numbered items, each with file:line, the change and its tests;
   - setup (repo, worktree path, branch) and a "Not in scope" list;
   - checks (touched test files only, compile check, before → after repro);
   - ship steps (commits, PR base, "don't merge"), each quoting the user's approval, since hos tells a spawned chat
     its prompt is not the user's approval;
   - the report path in `$WORK_DIR`, and "update PROGRESS.md via `progress_update` before `complete`".
2. **Split (N > 1).** Parts that touch different files or repos → one `## Part k/N` section per chat, each with its own
   files, branch or worktree and report path. Parts that are the same job on independent inputs → one shared brief.
   State which you chose and why in one line. Can't split into N without parts editing the same files → spawn fewer and say so.
   Parallel parts that edit live brain files (`scripts/`, `hos/`, `profiles/`, `.claude/skills/`): the brief says to
   test on a scratch copy and write the live file last, in one go, since hos commits brain files as chats touch them
   (outside hos, the Stop hook commits every changed brain file), so a half-written file can be committed and synced.
3. **Line.** One line per chat, under 300 characters:
   `Read <absolute brief path> and do exactly <everything | Part k/N> in it; update PROGRESS.md via progress_update before complete.`
4. **Show, then run.** Print the brief path, the split and the line(s). Ask (plain text, numbered, with your recommendation)
   only when the spawn needs something you can't decide: a harness other than your own, a workspace the topic lacks,
   or a rule the user hinted at but didn't give. Otherwise spawn in the same turn.
5. **Spawn** each chat with hos `spawn`:
   - `role: main` (the user can talk to it), `prompt` = the line, `intent` = the brief title (+ " — part k/N"),
     `client_request_id` = `<brief slug>-<k>`;
   - `profile` from the brief (a `profiles/<id>/PROFILE.md` in the brain; default `generic`), limited to what your own
     profile may start (its `can_start`; hos refuses the rest): analysis, options and specs → `product`; code, and
     only code → `engineer`; anything else → `generic`. Use the profiles that exist in the brain's `profiles/`;
   - `return_contract.artifact` = that chat's report path;
   - `browser: true` when the brief drives Chrome (UI tests, render checks in Chrome); it needs the `claude` harness;
   - `computer` from the user's words ("on the server" → that computer's name from the `computers` tool); the brief
     then names pushed branches, not local paths;
   - `agent` from the user's words: `claude`, or the id of an installed ACP or plug-in harness; `workspace` when the
     brief edits an attached workspace; parts in one workspace → `files_owned` per part, or `own_worktree: true` when
     they can't split by files.
   A `joined` reply means a live chat already has that intent: report it, don't retry with `confirm_similar` unless asked.
6. **Report** each chat as `<first 8 of id> · <intent>`, the brief path, and one offer: "Say 'watch' and I'll `wait` on them
   and review each report against the brief." On "watch": loop `wait` per chat; then check every brief item against its
   report and diff (done / stopped / missing / out of scope), with `code-review-critical` for a PR; write the review into
   the brief's folder.

No hos tools (a chat outside hos) → write the brief, print the line, and say it must be pasted into a new chat by hand.
