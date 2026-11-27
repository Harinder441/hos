# hos docs and product page

Run your agents like a team that remembers.

The docs site (Astro Starlight, dark hos theme) and the product page at `/`. It is its own npm package, so the app's
dependencies stay untouched.

```sh
cd docs/site
npm ci
npm run dev           # local preview
npm run build         # static site in dist/
npm run build:check   # a copy in dist-check/ that opens from file://, for headless renders
```

- Pages: `src/content/docs/docs/*.md`, in the order of `src/order.mjs` (13 pages).
- Pages 6 and 7 (`make-it-yours.md`, `extend-hos.md`) are generated from the hos skill's recipes
  (`../../skills/hos/recipes/*.md`) by `scripts/gen-recipes.mjs`, with the intro text in `recipe-pages/`. `npm run build`
  regenerates them first; `npm run gen:check` exits 1 when the committed pages are stale. Each recipe section's anchor
  is the recipe id, so a recipe's `docs: <page>#<id>` link always resolves.
- Screenshots: `src/assets/shots/`, from real Claude chats on a demo hos. See "Screenshots" below.
- Product page: `src/pages/index.astro` with `src/styles/landing.css`.
- For agents: `/llms.txt`, `/llms-full.txt`, and a Markdown twin of every page at `/docs/<page>.md`.
- Fonts are bundled from `@fontsource-variable`; the site loads nothing from other hosts. Astro telemetry is off in
  every script (`ASTRO_TELEMETRY_DISABLED=1`).
- `DOCS_SITE` sets the public address used for the sitemap and canonical links (default
  `https://hos-docs.example.com`, a placeholder until the site has a home).
- Places still waiting on the release job carry `TODO-T19` (the tag and hash in the install prompt):
  `rg -n 'TODO-T19' src`.

## Screenshots

The shots in `src/assets/shots/` come from real Claude chats on a demo hos. That hos has its own port, data folder
and tmux socket. Its brain belongs to "Alex", and three small demo repos (notes-api, notes-web, sync-service) sit
under `/tmp/demo`. Nothing in them comes from a real user. Every demo chat runs on Haiku at low effort, and the story
costs about 20 agent turns. From the repo root, after `npm ci && npm run build`:

```sh
scripts/demo-hos.sh setup       # starter brain adopted as Alex, demo repos, Haiku in every profile
scripts/demo-hos.sh start       # http://localhost:4627, signed in to Claude with this computer's login
npx tsx scripts/ui-shots-real.ts enrol docs/site/src/assets/shots   # s6, before a passkey exists
npx tsx scripts/ui-shots-real.ts story docs/site/src/assets/shots   # the chats, then s1–s5 and s7–s11
scripts/demo-hos.sh stop
```

- `HOS_DEMO_DIR`, `HOS_DEMO_PORT`, `HOS_DEMO_STARTER` and `HOS_DEMO_BUILD` change the folder, the port, the starter
  brain and the hos build that runs.
- The story sends fixed prompts, but the agents answer for real, so every run differs. The second prompt answers a
  question the lead asked in the run these shots come from. If a run goes another way, drive it step by step instead
  (`topic`, `send`, `status`, `shoot <dir> s2,s3`) and look at each shot.
- s1 needs the lead's web search still waiting on its approval card, so the story takes it at that moment.
- Before you commit new shots, look at each one at full size. Check for names, emails, hostnames and home-folder
  paths; open tool calls can show a file owner's user name. The script strips PNG metadata.
- `scripts/ui-shots.ts --docs` still makes the older scripted-agent set, without Claude.

## Node and dependencies

- Node 22.19 or newer. Astro 7.3 needs 22.12; its `undici` dependency declares 22.19. On 22.15 the build still
  completes, with an `EBADENGINE` warning from npm.
- Astro is pinned at 7.3.8. `npm audit` reports one moderate advisory for astro 7.4.6 and older (GHSA-mh32-jxcr-mh9f,
  GHSA-r3h5-4585-7x3w). Neither path is used by this static site: no dynamic tag names from input, no
  `@astrojs/node` image endpoint. The fix, astro 7.4.7 or newer, needs Node 22.23.4 or newer; upgrade when the build
  machine has it.
