---
id: add-a-data-source
title: Add a data source
kind: code
size: M
hos: ">=0.1"
source:
  - src/plugins/types.ts
  - src/plugins/registry.ts
  - src/plugins/loader.ts
  - src/plugins/kit.ts
  - src/plugins/local.ts
  - src/policy.ts
  - src/snags/README.md
  - src/main.ts
docs: extend-hos#add-a-data-source
---

# Add a data source

Home has three sections: your tasks for today, a capture box and today's calendar. The Snags page lists snags. Each
one reads from a source. hos ships a local source, "This computer", for tasks, capture and snags. It has no calendar
source, so Home hides the calendar until you add one.

A data source plug-in is one small file in your brain's `hos/plugins/` folder. It reads from your own system: a task
app, a calendar, an issue tracker. It replaces the local source for its kind. A plug-in can also be a notifier: hos
hands it a short status screen (chats waiting for you, chats running, open snags) every minute and it sends that on.

hos runs plug-in code with its own rights. So whatever your approval settings say, hos asks you every time an agent
writes in `hos/plugins/` or changes the `plugins:` list.

**What you get:** a file in `hos/plugins/`, a line in `plugins:` in `hos/policy.yaml`, a Doctor row "Plug-in
<name>", and your system's name on the Home section after a restart. hos itself doesn't change.

**Ask your agent:** "Use the hos skill to add a data source for <my system>'s <tasks / capture / calendar / snags>."

---

## For the agent

### Ask the user (once, all together, defaults shown)

1. **Kind**: `tasks` (Today list; hos also adds a task there when a hos task needs the user), `capture` (capture
   box), `calendar` (today's events, optional "now" line), `snags`, or `notifier`. One plug-in may provide several.
2. **How to reach the system**: a CLI on `PATH`, an HTTP API, or a local file. Where its credentials live: an
   environment variable or a config file outside the brain. Never in `hos/policy.yaml`, which the brain commits.
3. **A test backend** (a test list or project) for the write checks. Default: none, dry checks only.
4. **Plug-in name**: lowercase letters, digits and dashes, up to 41 characters. Default: `<system>-<kind>`.
5. **Options** it needs (a CLI path, a timeout). Default: none.

### Steps

1. Read the interface in the hos checkout that matches `hos --version` (the `hos` key in `shared/LOCATIONS.md`, else
   ask): `src/plugins/types.ts` (the source interfaces and `PluginHost`), the kind table in
   `src/plugins/registry.ts` (required methods), and the checks for the kind in `src/plugins/kit.ts`. For snags,
   read `src/snags/README.md` too. Don't edit hos.
2. Draft the file in a scratch folder (the work folder), not in `hos/plugins/`, so each try doesn't raise an
   approval card. It is a plain ES module that imports nothing from hos; everything comes from `host`.

   ```js
   export default {
     name: 'my-tasks',
     apiVersion: 1, // 1 is enough for data sources; 2 adds host.acp and host.tools
     register(host) {
       const bin = typeof host.options.bin === 'string' ? host.options.bin : 'my-cli';
       host.provide({
         kind: 'tasks',
         version: 1,
         label: 'My app',
         async today() {
           // { available, tasks: [{ id, title, due: 'HH:MM' or null, link? }], error? }
           return { available: true, tasks: [] };
         },
         async done(id) { return { available: true, ok: true }; },
         async addLinked(title, priority, link) { return { ok: true, id: 'new-id' }; },
         async drop(id) { return { available: true, ok: true }; },
         async setPriority(id, priority) { return { available: true, ok: true }; },
       });
     },
   };
   ```

   Methods per kind (all async unless noted):
   - `tasks`: `today`, `done`, `addLinked`, `drop`, `setPriority`. Priority is `high`, `normal` or `low`.
   - `capture`: `capture(text)`, returns `{ available, ok, error? }`.
   - `calendar`: `today()` returns `{ available, events: [{ time, title }], error? }`. Optional `now()` (time
     blocks with `HH:MM` start and end) and `link` (an http(s) URL).
   - `snags`: `status()` (not async), `list`, `get`, `find`, `add`, `change`, `comment`, `localFile`. Keep files
     through `host.snagFiles`.
   - `notifier`: `push(screen)`; optional `everyMs` (default 60 s). Several notifiers may run.
3. Follow the host rules:
   - Call `host.provide()` only inside `register()`. Import and `register()` each get 10 s; do slow work inside the
     methods.
   - When the system can't be reached, return `available: false` with an `error`. Don't throw from a read.
   - Store state with `host.sqlite('<file>.db')`, which opens a file in the plug-in's own folder `host.dataDir`.
   - Use `host.now()`, `host.setTimeout()` and `host.log()`; use `host.fail(status, message)` for an error the API
     should show with that status.
4. Run the kit on the draft: `hos plugin-check <draft>.mjs --options '<json>'`. If the user gave a test backend, run it
   again with `--write`, which adds, changes and closes test items.
5. Copy the file to `hos/plugins/<name>.mjs` and add it to `hos/policy.yaml` (both raise an approval card):

   ```yaml
   plugins:  # plug-in files in hos/plugins/, loaded when hos starts
     - file: my-tasks.mjs
       options: { bin: my-cli }
   ```

   A plain `- my-tasks.mjs` line works when there are no options.
6. Ask the user before restarting hos, then run `hos keeper restart`. Plug-ins load only at start.

### Check

```sh
hos plugin-check hos/plugins/<name>.mjs   # every line PASS, then "all checks passed"
hos validate                               # the plugins: list has the right shape
```

After the restart, the hos Doctor shows "Plug-in <name>" as ok with "<file> provides <kinds>", and the Home section
shows the plug-in's `label`.

### If it fails

The Doctor row and the kit say why. hos still starts without the plug-in.
- "plug-in files must sit in …": the file is outside `hos/plugins/`, or the list names another path.
- "is written for plug-in API N; this hos runs API M": lower `apiVersion`, or update hos.
- "… source "<label>" is missing …": add the named methods.
- "did not finish register() within 10 s": move the slow work out of `register()`.
- "<kind> already comes from the plug-in …": two plug-ins give the same kind; the first in the list wins. Remove one.
- Any throw in `register()` skips the whole plug-in. Fix it, run the kit, restart.

### Undo

Remove the line from `plugins:` and restart: the local source comes back. Delete the file. Its data stays in the
plug-in's folder under the hos data dir. Tell the user it's there; don't delete it.

### Don't

- Don't import from hos's `src/` or `dist/`. A plug-in that only uses `host` keeps working across hos versions.
- Don't put tokens or passwords in `options` or anywhere in the brain.
- Don't add code for a particular app to hos itself. Sources that are yours alone live in the brain.
- Don't run `--write` against the user's real lists.
- Don't restart hos without the user's yes in this chat.
