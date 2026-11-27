# Contributing to hos

Issues and pull requests are welcome. For anything larger than a small fix, open an issue first so we can agree on
the shape before you build it.

## Set up

Node 22, git and a C/C++ toolchain (for `better-sqlite3` and `node-pty`); tmux for terminals and dev servers.

```sh
npm ci
npm run build
```

Run a scratch daemon against a scratch brain and data folder, never your real ones:

```sh
HOS_BRAIN=/tmp/hos-brain node dist/daemon/main.js --port 4599 --data-dir /tmp/hos-data --tmux-socket /tmp/hos-tmux
```

## Checks

- While you work: `npm run check -- <areas you touched>` (type check plus the matching unit tests; `--list` shows
  what it picked). If you changed `web/` or an HTTP route, also `npm run check:e2e -- <areas>`.
- Before a pull request: `npm run test:full`, `node scripts/check-hover-text.mjs`, and
  `node docs/site/scripts/gen-recipes.mjs --check` if you changed a recipe in `skills/hos/recipes/`.
- CI runs the type check, the hover-text and recipe checks, the unit tests and the docs build on Linux and macOS.
- Tests sit at the daemon boundary (HTTP, the bus, the fakes in `src/fakes/`). They never touch your real repos,
  tmux server, Keychain or subscriptions: use temp folders, temp git repos, a separate tmux socket and the fakes.
  Live tests (`*.live.test.ts`) are opt-in and run by hand.

## Pull requests

- One change per pull request, with a test where behaviour changes.
- Every control in the web app has hover text (`title`).
- A change to files a recipe in `skills/hos/recipes/` lists should update that recipe in the same pull request.
- No API-key path for Claude, and no code that reads or moves the user's own Claude login.
- New outbound network calls need a reason in the pull request and a line in the docs' security page.

## Licence

hos is Apache-2.0. By sending a contribution you agree it is licensed under the same terms (Apache-2.0, section 5).
There is no CLA.

Security problems: see [SECURITY.md](SECURITY.md), not the issue tracker.
