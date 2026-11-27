# Snags

The user's log of hos bugs, slowness and questions (`S1`, `S2`, …). They add them from the sidebar or the Snags page (`#/snags`); agents use the bus tools `snags`, `snag_read`, `snag_add`, `snag_comment`, `snag_resolve` and `snag_delete`.

- Data lives in the snag source (`src/plugins/`, kind `snags`). The built-in one keeps snags, comments and file names in `<dataDir>/plugins/local/local-store.db`; it is never offline and never queues. A plug-in from the brain's `hos/plugins/` can replace it (see `src/plugins/types.ts`, `SnagSource`). `Snags` (`snags.ts`) holds the checks (kinds, text and file limits, the commit-ref rule on resolve) and turns source records into the `Snag` the API and bus show.
- A source that can be offline reports it through `status()`; the summary carries `offline`, `queued` and the source `label`, shown as "<label> offline · N queued" in the sidebar and on the Snags page. A source may hand out `S?<n>` refs (negative ids) for snags it has not stored yet, and calls `host.snagReached(n, record)` once it has; the chat that added it gets a quiet notice with the new ref.
- Files: `<brain>/.context/snags/S<n>/` for a plug-in source, `<brain>/.context/snags/local/S<n>/` for the built-in one, so switching sources never mixes or deletes another store's files (`files.ts`; pending ones in `pending-<n>/`). Sources save, move and remove them through `host.snagFiles`.
- Start topic / Chat in topic send the snag text plus its absolute file paths as the first message, link the snag to the chat (change `link`), and ask the agent to call `snag_resolve` when done.
- `context` (plain text, ≤600 chars) is a hint of where the snag was added: the calling chat for `snag_add`, or the topic and chat open in the web form. `Hos.snagContext` builds it from the topic title, the chat's card and its last two user messages; `snag_read` prints it after "Added by…" and flags it as possibly stale.
- Comments: `snag_comment` posts to the snag's thread (author `claude`); the user replies with Comment on a snag card (`POST /api/snags/:ref/comment`). `snag_read` prints the thread under `Comments:`, and the `snags` list marks who wrote last from `last_comment_author`.
- A source may name the `created_by` values it writes itself in `authors` (for snags added outside hos); the card then shows "from <label>".
- Kinds: `fix`, `question` and `context` (a skill, profile or shared memory needs a line; the auto sweep applies these). The summary's `openContext` counts open context snags, and the sidebar count leaves them out; the Snags page lists them with a Context tag and filter.
- Edit on a snag card changes its text (`POST /api/snags/:ref/edit` → change `update`).

## Removing it

Delete `src/snags/`, `web/src/snags/`, `test/snags.test.ts` and `e2e/snags.spec.ts`, then undo these mounts:

- `src/daemon.ts`: the `Snags` import, `const snags = …` and `snagsReady`, `snags` in `services` and in `sourcesInfo`.
- `src/plugins/`: the `snags` kind in `registry.ts`, `SnagSource` and the snag types in `types.ts`, `localSnags` in `local.ts`, the snag checks in `kit.ts`, `snagFiles` and `snagReached` in the host (`loader.ts`).
- `src/desk-screen.ts`: the `snags` parameter and `open_snags`.
- `src/http.ts`: the two snags imports, `snags?: Snags` in `Services`, the `snagRoutes` spread in `serviceRoutes`, and `services?.snags` passed to `handleBusRequest`.
- `src/bus-http.ts`: the two snags imports, the `snags` parameter and `registerSnagTools` call.
- `src/bus.ts`: `'snag_add'` in `CLEAN_ONLY_TOOLS`.
- `src/core.ts`: `snagContext`, `noteChat`, `clipped` and the `SNAG_CONTEXT_*` constants.
- `web/src/App.tsx`: the `onSnagEvent` import and call, the lazy `SnagsPage` and the `'snags'` case.
- `web/src/shell/routes.ts`: the `snags` route.
- `web/src/shell/Sidebar.tsx`: the `SidebarSnags` import and element.
- `e2e/shell.spec.ts`: the Snags region assertion.

`RawBody` in `src/http.ts`, the public `HosClient.request` and the `.side-pinned` sidebar block are general and can stay. Delete `.context/snags/` too.
