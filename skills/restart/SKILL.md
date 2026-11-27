---
name: restart
description: Hand this hos chat off to a fresh successor now. Use when the user types /restart or says "restart this chat", "hand off now", "start a fresh chat from here". Only queues the handoff; the handoff skill still writes PROGRESS.md when hos asks. NOT for restarting the hos daemon or a dev server.
---

# Restart

1. Find your own chat id: the `(you)` line of the hos `roster`, or hos `whoami`.
2. Queue the handoff with hos's local handoff route (loopback only; the token file is written by the hos daemon on
   this computer). Run it with `run_in_background`:

   ```bash
   curl -sS -X POST -H "Authorization: Bearer $(tr -d '[:space:]' < "${HOS_DATA_DIR:-$HOME/.hos}/local-ops.token")" \
     -H 'Content-Type: application/json' -d '{"mode":"write"}' \
     "${HOS_URL:-http://localhost:4517}/local/chats/<chatId>/handoff"
   ```

   The hos repo's `scripts/handoff-chat.sh <chatId>` does the same and then waits for the successor; use it instead
   when you have a hos checkout. hos queues the handoff until this chat is quiet (turn over, no subagents, no busy
   child chats). It refuses with a reason (`{"error": …}`) → tell the user the reason and stop.
3. End the turn with one line: "Handoff queued; hos will ask me for PROGRESS.md once I'm idle, then start the successor."
4. When hos asks, run the `handoff` skill and call `handoff_ready`.

No hos tools (a chat outside hos) → say so; there is no successor to start.
