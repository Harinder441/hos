---
title: Add a harness
description: What hos needs from any coding agent, the two ways to plug one in (ACP or an SDK), and how to test it.
---

A harness is how hos runs one kind of coding agent. hos ships two: **Claude**, which runs the real Claude Code
through its Agent SDK, and a **generic ACP harness** for any agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com). Adding an ACP agent is one entry under `harnesses:` in
your brain's `hos/policy.yaml`; anything else is one plug-in file in your brain plus one line in `plugins:`.

:::note[Unstable until 1.0]
The harness interface may change before hos 1.0. A release that breaks it says so in its release notes, and the
plug-in API carries a version number (`apiVersion`) that hos checks when it loads a plug-in.
:::

Your agent can do all of this with the hos skill's [Add a harness](../extend-hos/#add-a-harness) recipe.

## What hos needs from any agent

1. **A stream of structured events**, not screen text: turn started, message text, tool started and finished,
   context usage, turn finished, errors.
2. **A permission callback** before each tool call, so hos can apply your approvals policy and show an approval card.
3. **Resume** by a session id, so a chat survives idle suspend and a restart.
4. **An interactive command** that reopens the same session in a terminal, for Take over.
5. Optional: **usage** (tokens, credits, limits) for the governor, and a **login command** hos can open in a
   terminal so the agent's own sign-in runs.

## Two ways in

| | ACP agent | Anything else |
|---|---|---|
| What you write | A config for the generic ACP harness: command, arguments, environment, mode names, memory files | A runtime that wraps the agent's SDK or CLI and emits hos events |
| Size | Small | Medium |
| Events | Read from standard ACP messages (`session/update` with its `usage_update` kind, `session/request_permission`) | Mapped by your runtime |

Check ACP first. Many agents already speak it.

## The interface

| Piece | What it is |
|---|---|
| `Harness` | `id`, `label`, `pool` (which slots it uses), `runtime`, `models()`, `slots`, `features` (what it supports). Optional: `aliases`, `badge` |
| `AgentRuntime` | `agent` (its name); `start(spec, sink)` returns a session; `transcript(id, cwd)` for history; `terminalCommand(spec)` for Take over. Optional: `loginCommand()`, `signedIn()`, `usage()`, `title()`, `dispose()` |
| `AgentSession` | `nativeId`, `send(text)`, `stop()` |
| `AgentSink` | Callbacks hos gives you: `event`, `beforeTool`, `permission`, `needsDecision`, `beforeTurn`, `refuse`, `beforeStop`, `beforeCompact` |
| `AgentEvent` | The event kinds. The minimum: `context.loaded`, `turn.started`, `message.delta` / `message.completed`, `tool.started` / `tool.completed`, `context.usage`, `turn.completed`, `error` |

### The tool gate

Every runtime calls the gate in the same order before a tool runs: `refuse` or `beforeTool` may deny it with a
reason; if `needsDecision` says so, `permission` asks you; then the decision goes back to the agent. hos's own tools
are allowed without asking.

### Tool names

Approvals classify tools by Claude Code's names: `Read`, `Glob`, `Grep`, `Bash`, `Write`, `Edit`, `WebFetch`,
`WebSearch`, `Agent`, and `mcp__<server>__<tool>`. Map your agent's tools onto these. A name hos doesn't know falls
into the "unclassified" class, which asks by default.

### The chat spec

`start()` gets the chat's folder, extra folders, environment, the session to resume, model and effort, and the hos
tool server to connect. A harness that ignores the hos tool server gives its chats no hos tools.

## Register it

- **An ACP agent:** an entry under `harnesses:` in `hos/policy.yaml` with its `id`, `label`, `command`, `args` and
  `env`, plus optional `modes`, `models`, `memory_files`, `login` and `signed_in`. Restart hos.
- **A plug-in:** a file in your brain's `hos/plugins/` that exports `name`, `apiVersion` and `register(host)`, and
  calls `host.provide({ kind: 'harness', … })` (or `host.acp(id, config)` for an ACP agent that needs special
  handling). List it under `plugins:` and restart hos. `hos plugin-check <file>` loads it on its own first.
- **A fork** can also add a harness in hos's own code.

Neither of the first two edits hos. A key you put in `env` sits in plain text in your brain, which hos commits and
pushes to your private repo; prefer the agent's own login.

## Test it

- **Contract scenario.** One shared test runs any runtime through: a write denied, a retry approved, a restart, and
  a recall. Your runtime's events must match the normalised event grammar.
- **Offline ACP.** A fake ACP agent lets you test an ACP config without a live agent or a login.
- **Live test.** Gate it behind an environment variable, and run it by hand.

## Known limits

- Some features are built for Claude first. A harness declares which of Take over, the browser, context refresh and
  usage limits it supports (`features`); chat titles and the login terminal are optional runtime methods.
- Attachments arrive as text that names the files. Image blocks are not part of the interface yet.
- Don't report plan limits from a second harness yet: the governor keeps one set of windows.
