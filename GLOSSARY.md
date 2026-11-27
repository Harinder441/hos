# hos

hos is an always-on agent operating system for one owner's computer. It runs agent chats, coordinates them, and lets the owner steer them from any device.

## Structure

**Brain**:
The owner's brain repo (started from hos-brain), whose rules, skills, routing and hos policy file govern every chat, and the working folder of every chat that has no sub-worktree of its own.
_Avoid_: config repo, orchestrator

**Project**:
A git repository that hos knows about.
_Avoid_: repo entry, app

**Topic**:
One job the owner gives hos, with a title, slug, work folder, state, tasks, locks and kill switch; its chats work from the brain and edit the workspaces attached to it.
_Avoid_: task, job, session, workspace (for the job itself)

**Work folder**:
A topic's folder in the brain, `work/<area>/<YYYY-MM-DD>-<slug>/` (`WORK_DIR` in its chats' environment), holding its PROGRESS.md and every file the topic writes in the brain. The Desk has none and picks one per deliverable.
_Avoid_: artifact folder, handoff dir, status topic

**Area**:
The first level under `work/`, one of the backticked names in the first column of the brain's `work/README.md` table; anything else is `misc`.

**PROGRESS.md**:
A work folder's single progress doc (Goal, State, Where, Decisions, Open, Tried, Leave alone, Checks, Next step, Log), written only by hos through `progress_update`; it is also the handoff a successor boots from.
_Avoid_: status file, handoff file

**Status topic**:
Retired: the `status/<slug>.md` file of earlier versions and the `status_update` tool. PROGRESS.md in the work folder replaces it; the word survives only as the topic's slug field (`statusTopic`).

**Workspace**:
A folder a topic works in: a project's main checkout (kind root) or a branch worktree cut from it (kind worktree), with its path, branch, base and setup state. One topic can attach several workspaces and one workspace can serve several topics.
_Avoid_: checkout (for a registered one), worktree (alone, when root is possible)

**Setup script**:
The one command, set in the brain's `hos/actions.yaml` `setup:` block (else hos's built-in `.env*` copy), that runs in the background each time hos creates a workspace (copying `.env*` from the root checkout, with per-repo exclusions); its state goes pending, running, then ready or failed, with a log.
_Avoid_: init script, bootstrap

**Chat**:
One agent session (Claude, or another harness) inside a topic.
_Avoid_: thread, session, conversation, agent

**Harness**:
An agent CLI hos drives (Claude primary; extras in `src/harnesses/<id>/`).

**Lineage**:
The chain of chats that continue one another through handoffs, shown as one conversation.
_Avoid_: chain, history

**Generation**:
A chat's position in its lineage (gen 1, gen 2, …).

**Spawn tree**:
Which chat started which.
_Avoid_: hierarchy, children list

**Successor**:
The chat that continues a lineage after a handoff.

## Coordination

**Bus**:
The MCP server every chat gets, through which it sees and coordinates with the rest of hos.
_Avoid_: API (for agents), tool server

**Card**:
A chat's short self-summary that other chats can read.
_Avoid_: status, summary

**Roster**:
The compact list of live chats in a topic, given to a chat at each turn start.

**Owned files**:
The path globs a spawned chat may edit, declared when it is spawned; a spawned chat with none is read-only.

**Lock**:
An advisory claim by one chat on paths in its topic's workspaces; other chats' edits there are refused, and it expires without a heartbeat.
_Avoid_: mutex, reservation

**Task**:
One unit of work on a topic's task list (ref T3): one outcome you can check, usually one landing that fits one chat, with a priority P1–P3, acceptance criteria, dependencies and a time limit. It is done only when every criterion is met and it has evidence. Shown in the topic's Tasks panel. A snag is a report about hos itself; a task is the work.
_Avoid_: ticket, todo (and never a synonym for topic or snag)

**Sub-worktree**:
A worktree hos creates for a spawned worker whose parent asked for `own_worktree`, because its work can't be split from the other workers' by files. Its work merges back into the workspace's worktree after review. Other workers share the workspace worktree, kept apart by their locks.
_Avoid_: fork, clone

**Notice**:
A batched one-line alert delivered to a chat about something it must react to. Only notices that need action (a child's result, time limits, shell changes inside a lock) wake an idle chat; the rest open its next turn.

**Return contract**:
What a spawned chat must hand back when it completes: an artifact path and a summary within a token cap.

**Parked**:
A chat waiting for the owner's answer to a question, workspace pick or plan it sent through the bus.

**Governor**:
The deterministic rules that admit, refuse or queue spawns and running chats.
_Avoid_: scheduler, orchestrator

**Slot**:
One running chat's place in a pool (one per harness); a chat that wants to start a turn when its pool is full is queued, except a lead or a chat with live children, which runs anyway; while an idle one has children running or queued, one slot stays kept for it so its children queue instead.

**Priority**:
P0 (the owner) to P4 (batch); it orders the queue and decides which chats still run when the governor throttles.
_Avoid_: urgency, rank

**Provider window**:
A subscription's usage window (Claude's 5-hour and weekly) whose utilization the governor throttles on.
_Avoid_: quota (alone), rate limit (for the window itself)

**Suspended**:
An idle chat whose process hos stopped to free memory; it keeps its state and resumes its native session on the next message.
_Avoid_: sleeping, paused (paused is a state a chat must be messaged out of)

**Ledger**:
The record of tokens each chat spent per turn, summed per chat, topic and provider.
_Avoid_: usage log, billing

**Handoff**:
A chat bringing its topic's PROGRESS.md up to date with the `handoff` skill and `progress_update`, then calling `handoff_ready`, so that a successor can continue the work.
_Avoid_: compaction, summary

**Quiet**:
A chat whose turn is over, with no subagents running and no busy child chats; the only moment hos runs a handoff the owner asked for.

**Handoff queue**:
The handoff waiting for a chat to be quiet (write or salvage), set only by the owner: "Hand off now", `/restart`, `POST /api/chats/:id/handoff` or `scripts/handoff-chat.sh`; kept in the store so a restart keeps it.

**Salvage handoff**:
A handoff file hos writes into the work folder (and points PROGRESS.md's Next step at) from a chat's card and recent events when the owner asks for a salvage, the chat's handoff failed validation twice or it kept stopping without one.

**Implement**:
The owner's Approve plan on a plan card (or the owner's own message to the chat starting with "implement", or the chat's `approve_plan` quoting the owner's latest message's approving words); it closes the plan card as approved and tells the chat to carry the plan out.
_Avoid_: approve, go ahead

**Topic state**:
active, blocked, review, done or archived.

**Boot tokens**:
A successor's context usage at the end of its first turn, the cost of starting from a handoff.

## Roles

**Main chat**:
Any chat the owner opens in a topic (role `main`); a topic can have several, all equal, and none leads it. Each plans, spawns helpers and may edit the brain and the topic's workspaces.
_Avoid_: root, planner, brain chat, lead, orchestrator, "the main chat"

**Worker**:
A chat that edits code in a topic's workspace.

**Reviewer**:
A chat that reads diffs and reports findings.

**Scout**:
A read-only chat that researches and returns a short summary.

## Safety

**Action class**:
A policy category (A0 read … A8 brain config) that decides whether an action is automatic, asked or denied.

**Kill switch**:
The owner's stop: global, per topic or per spawn subtree; it refuses new spawns and interrupts running chats.

**Ping-pong**:
Two chats messaging back and forth with no artifact or diff change; hos pauses both after three round-trips.

**Approval**:
A decision by the owner, and only the owner, recorded from a computer or phone.
_Avoid_: consent from a chat, permission (when meaning the human decision)

## Surfaces

**Transport**:
How the web app reaches the daemon from another device: Tailscale or Cloudflare.
_Avoid_: tunnel (alone), network mode

**Computer**:
Another machine's hos paired with this one under Settings → Computers. A computer added here ("out") can run chats started from here; one allowed here ("in") can start chats on this one. Pairing is one way.
_Avoid_: peer, host (that's a schedule's machine), node

**Stub chat**:
This computer's row for a chat that runs on another computer (`chat.computer` set): it fills from that computer's event stream, and acting on it forwards there. The chat itself never moves.
_Avoid_: remote copy, mirror chat

**Home (topic)**:
The computer a topic was started on (`topic.home`, empty for this one); a topic mirrored onto another computer keeps its id and work folder and shows ⌂ on its home.
_Avoid_: owner, origin

**Inbox**:
The daemon's feed of plans, approvals, questions, completions, failures and keeper alerts; it drives push, and its open plans, questions and approvals are what Home's Needs you lists. There is no Inbox page.
_Avoid_: notifications, alerts

**Push**:
A Web Push notification of an Inbox item to an installed hos app; it names only the kind, topic, chat and action class, and opens that chat.
_Avoid_: alert (that's an Inbox kind)

**Device**:
A browser install of hos that registered for push (the phone's Home Screen app, a desktop Dock app).

**Tab**:
One of the three bottom tabs of the phone layout: Home, Chats, More.

**Chat tab**:
One chat lineage of a topic in the strip above its thread; **+** starts another main chat in the same topic, and × only hides a tab on this device. No tab is pinned; tabs follow tab order, then creation.

**Link**:
A tie the owner makes between a chat lineage and another lineage (both ways) or a diagram, in any topic, by dropping a tab on a chat's thread or with **+** → Link chat… / Attach diagram…; a linked chat can be reached with `send` and is listed in the roster, and a linked diagram is in the briefing. Agents never make links.
_Avoid_: bind, its chat (for a diagram)

**Context ring**:
The composer's circle that fills as the chat's latest context sample nears its handoff line; the % shows only in its tooltip. Under it, a Claude chat shows its context breakdown after turn 1 (system and tools, skills, CLAUDE.md, messages).

**Terminal dock**:
The shell docked under a topic's Workspaces panel, one per workspace, opened in the workspace folder and reused across reloads.

**Action**:
A named custom command, defined once, shown as a button and a bus tool.
_Avoid_: script, shortcut

**Server**:
A dev server running in a tmux session named `<workspace>-<app>-<port>`.
_Avoid_: preview, process

**Unmanaged listener**:
A process listening on a TCP port that was not started inside tmux, shown apart from servers so stray processes stand out.

**Keeper**:
Everything that keeps the computer awake and hos running and recovering.
_Avoid_: supervisor, watchdog (the watchdog is one part of it)

**Watchdog**:
An optional outside check (a ping URL such as healthchecks.io) the daemon pings every minute; when the pings stop, that service alerts the owner.

**Interrupted chat**:
A chat that was mid-turn when hos stopped or paused it for the battery; the keeper resumes it with a `[hos]` note.

**Health page**:
The Keeper view's live state of the daemon, tmux, transport, disk, battery, thermal, memory, provider windows, sleep, watchdog and backups.

**Doctor**:
The checks of the machine's setup (transport, LaunchAgent, watchdog, charge limit, logins, the code viewer, added computers), each with its fix.
_Avoid_: diagnostics
