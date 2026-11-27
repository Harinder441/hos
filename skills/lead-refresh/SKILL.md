---
name: lead-refresh
description: >-
  Refresh a lead chat's context in place, same chat; NOT a handoff. Bring PROGRESS.md up to date (finished work shrinks to one line with its link, live work stays), call refresh_ready, and hos clears this chat's context and starts it again from PROGRESS.md. Use when hos says "[hos] Context refresh: … Run the lead-refresh skill now" (only the user's Refresh context button; hos never asks on its own), or when the user says "refresh the lead". NOT for handing off to a successor chat (handoff), or for starting new work in another chat (fresh-chat).
---

# Lead refresh

Same chat, same id, tasks, locks and card. You write PROGRESS.md only: no handoff file, no successor. You can't start
a refresh yourself; hos asks when the user presses Refresh context (shown only for profiles with `context_refresh: true`).

## When hos asks

1. Read `progress_read`, `tasks` and `roster`.
2. One `progress_update` so every section is true now:
   - **State:** one line per live chat, `<id8> · <profile> · <doing> · <task ref>`; then each open task: done and left.
   - **Closed work:** one line each: what it was, **done** / **in plan only** / **not done**, and where it is (file,
     commit, PR, report). Drop the detail.
   - **Decisions:** only the ones live work depends on. Drop decisions about closed work
     (git keeps them).
   - **Open:** what waits on the user or a chat, each with options and your recommendation. Close what's finished.
   - Remove every stale line, so nothing is left over from the past. Stay under the 8,000-character warning line;
     link detail files instead of copying them.
   - **Next step:** what you do first after the refresh.
3. Call `refresh_ready`. If hos lists problems, fix them with `progress_update` and call it once more.

## After the refresh

hos says "[hos] Your context was refreshed". Read PROGRESS.md (`progress_read`), `tasks` and `roster`. Continue
pending work, or greet the user in one line. Don't `wait` on chats that are still working: each one's done notice
wakes you.
