# hos

An always-on agent OS for one computer. A local daemon owns every agent chat, and one web app (PWA) serves the computer, a phone and any browser. The owner's brain repo (started from hos-brain) holds the rules, skills, profiles and the hos policy file.

## Rules

- Subscriptions only: drive the unmodified `claude` binary through the Agent SDK under the user's own login. Other harnesses come in through `harnesses:` in the brain or a plug-in (the generic ACP harness ships). Never add an API-key path, and never read or move the host's own Claude login.
- Tests live only at the seam in `docs/adr/0003-test-seam-daemon-boundary.md`: the daemon boundary with the injected fakes in `src/fakes/`.
- Tests never touch the developer's real repos, tmux server, Keychain or subscriptions: use temp dirs, temp git repos, a separate tmux socket and the injected fakes. Live contract tests (`*.live.test.ts`) are opt-in and run by hand.
- Verification is tiered. While iterating: `npm run check -- <areas you touched>` (tsc + the matching unit tests; `--list` shows the selection). If you changed `web/` or an HTTP route, also `npm run check:e2e -- <areas>`. Run `npm run test:full` once before a pull request. A test that only passes on retry is a bug, not a pass. Use a unique `HOS_E2E_PORT` per worktree.
- The daemon binds to loopback only. Remote access goes through the transport adapter (`docs/adr/0005-transport-adapter-loopback-only.md`).
- Anything that installs software or changes machine settings (launchd, systemd, `pmset`, Tailscale, Cloudflare) needs the user's explicit OK.
- Stack: Node 22 + TypeScript (daemon), React + Vite (PWA), SQLite (single writer: the daemon), Vitest, Playwright. The dependency manager is npm.

## Domain docs

`GLOSSARY.md` and `docs/adr/` at the repo root. User docs: `docs/site/`. Contributing: `CONTRIBUTING.md`.
