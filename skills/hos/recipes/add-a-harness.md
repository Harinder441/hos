---
id: add-a-harness
title: Add a harness
kind: code
size: M
hos: ">=0.1"
source:
  - src/plugins/types.ts
  - src/plugins/registry.ts
  - src/plugins/kit.ts
  - src/harnesses/harness.ts
  - src/harnesses/setup.ts
  - src/harnesses/tools.ts
  - src/harnesses/acp/config.ts
  - src/harnesses/acp/index.ts
  - src/adapters/agent-runtime.ts
  - test/acp.test.ts
docs: extend-hos#add-a-harness
---

# Add a harness

A harness is how hos runs one kind of coding agent. hos ships two: Claude, which runs the real Claude Code through
its Agent SDK, and a generic harness for any agent that speaks the Agent Client Protocol (ACP).

There are two ways to add an ACP agent, and neither changes hos:
- **No code:** a `harnesses:` entry in your brain's `hos/policy.yaml` with the agent's command, arguments and
  environment. This is the right way for most agents.
- **A plug-in:** a file in `hos/plugins/` for an agent that needs special handling (its own tool names, its own
  replay marker). hos asks you every time an agent writes that file or changes the `plugins:` list.

hos runs the agent's own program under your own sign-in. It never uses an API key and never stores the agent's login.

Some hos features need help from the agent. Each harness declares which ones it has, and hos hides the rest for its
chats: **Take over** (open the chat in a terminal), the **browser**, **context refresh** and **plan limits**.

**What you get:** the agent in the harness picker for new chats, a Doctor row for its sign-in, and its chats
surviving a restart. You need to restart hos once.

**Ask your agent:** "Use the hos skill to add <agent> as a harness."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **The agent and its ACP command**, from its docs or `--help` (often `<agent> acp`). Check with `command -v` that
   it is installed. If it isn't, installing it is a `[user]` step. Don't install it yourself.
2. **id and label**: id is lowercase letters, digits and dashes, up to 40 characters. Chats store it, so never
   change it later. Default: the agent's name.
3. **Terminal, login and sign-in check commands**: the command that reopens a session in a terminal, with
   `{session}` where the session id goes (Take over), the login command, and a command that exits 0 when signed in.
   Default: none, so hos has no Take over for it and its Doctor row says "off".
4. **Models** (ids and the names of its model and effort options), **mode names** for build and plan, **memory
   files** it reads (for example `AGENTS.md`). Default: one model, "Agent default"; no modes or memory files.
5. **Slots** (its chats running at once; default 2) and **special handling** (default none, so path A).

### Steps

1. Read the harness types in the hos checkout that matches `hos --version` (the `hos` key in
   `shared/LOCATIONS.md`, else ask): `src/harnesses/acp/config.ts` (`AcpConfig`, `AcpHooks`),
   `src/harnesses/acp/index.ts` (the `harnesses:` keys), `src/harnesses/harness.ts` (features).
2. **Path A, no code.** Add to `hos/policy.yaml`:

   ```yaml
   harnesses:  # ACP agents hos runs next to Claude; restart hos after a change
     - id: my-agent
       label: My agent
       command: my-agent
       args: [acp]
       terminal: [my-agent, --resume, '{session}']  # Take over; leave it out and hos hides Take over
       login: [my-agent, login]
       signed_in: [my-agent, whoami]               # exit 0 = signed in
       models: { default: fast, effort: high, list: [{ id: fast, label: Fast }] }
       model_option: model
       modes: { build: code, plan: plan }
       memory_files: [AGENTS.md]
   ```

   The other keys it takes: `env`, `pool`, `slots`, `effort_option`, `first_turn_note`, `aliases`. Any other key
   makes the entry fail. Effort is one of `low`, `medium`, `high`, `xhigh`, `max`.
3. **Path B, a plug-in.** Draft it in a scratch folder first, then copy it to `hos/plugins/<name>.mjs` (one approval
   card). It imports nothing from hos.

   ```js
   export default {
     name: 'my-agent',
     apiVersion: 2, // host.acp needs plug-in API 2
     register(host) {
       const command = typeof host.options.command === 'string' ? host.options.command : 'my-agent';
       const runtime = host.acp('my-agent', {
         name: 'My agent',
         command,
         args: ['acp'],
         terminal: [command, '--resume', '{session}'],
         login: [command, 'login'],
         signedIn: [command, 'whoami'],
         hooks: {}, // tool, replay, newSession, update, skills, autoAllow, serverReady
       });
       host.provide({
         kind: 'harness',
         version: 1,
         id: 'my-agent',
         label: 'My agent',
         models: () => ({ default: 'fast', effort: 'high', list: [{ id: 'fast', label: 'Fast' }] }),
         runtime,
       });
     },
   };
   ```

   Then add `- my-agent.mjs` to `plugins:` in `hos/policy.yaml`. Optional fields on the harness: `pool`, `slots`,
   `aliases` (old ids whose chats it should answer), `features`.
4. **Features.** An ACP harness has Take over when it names a `terminal` command; the rest are off. Set
   `features: { browser: true }` (or `contextRefresh`, `usageLimits`, `takeover`) only when the agent really does
   it. When one is off, hos answers Take over with "… has no Take over", hides the browser switch and refuses
   `browser: true` spawns, hides and refuses context refresh, and ignores its plan-limit events (so it can't slow
   Claude's chats).
5. **Tool names.** Approvals classify tools by the names in `host.tools` (`Read`, `Edit`, `Bash`, `WebFetch`,
   `Agent`, `mcp__<server>__<tool>` …). If the agent uses other names, map them in the `tool` hook. A name hos
   doesn't know is "unclassified" and asks by default.
6. Ask the user before restarting hos, then run `hos keeper restart`.

### Check

```sh
hos validate                                # the harnesses: entry or plugins: line is valid
hos plugin-check hos/plugins/<name>.mjs     # path B: shape, features, sign-in
```

`hos plugin-check --write` starts the agent for one short turn. That uses the user's own subscription, so ask first.
After the restart: the agent is in the new-chat harness picker, and the Doctor shows "<label> sign-in". Start one chat
on it, ask it to write a file, and approve the card.

### If it fails

- Doctor row "Harness settings": the `harnesses:` entry names the bad key; fix it and restart.
- "… offers the harness id X, which … already uses": pick another id. Claude's id is taken.
- "<label> sign-in" is down: the user runs the login command from the row in a terminal.
- A chat ends at once: run the ACP command by hand. Most often the agent isn't signed in or the arguments are wrong.

### Undo

Remove the entry or the `plugins:` line and restart. Chats started on it stay in the store and answer "not
installed" until it comes back with the same id.

### Don't

- Don't use an API key or copy the agent's login anywhere. The agent signs in by itself.
- Don't change an id once chats use it. Add the old id to `aliases` instead.
- Don't turn on a feature the agent lacks to make a button show.
- Don't write a non-ACP runtime here. That is a larger job: recipe `change-hos`, tested with `test/contract.ts`.
