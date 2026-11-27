#!/bin/bash
# A scratch hos with a demo brain ("Alex") and three small demo repos, for the docs screenshots from real chats.
# Usage: scripts/demo-hos.sh setup|start|stop|status
# Env: HOS_DEMO_DIR (default /tmp/demo), HOS_DEMO_PORT (default 4627), HOS_DEMO_STARTER (git url or path of the starter brain),
#      HOS_DEMO_BUILD (a built hos checkout to run; default this repo), HOS_DEMO_MODEL (default claude-haiku-5-5).
set -euo pipefail

D=${HOS_DEMO_DIR:-/tmp/demo}
PORT=${HOS_DEMO_PORT:-4627}
STARTER=${HOS_DEMO_STARTER:-https://github.com/Harinder441/hos-brain}
REPO=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${HOS_DEMO_BUILD:-$REPO}
MODEL=${HOS_DEMO_MODEL:-claude-haiku-5-5}
[ "$PORT" = 4517 ] && { echo "4517 is the default hos port; pick another"; exit 1; }

demo_git() { GIT_CONFIG_GLOBAL="$D/gitconfig" GIT_CONFIG_NOSYSTEM=1 git "$@"; }

repo() {
  local name=$1
  mkdir -p "$D/code/$name" "$D/remotes"
  demo_git init -q -b main "$D/code/$name"
}

publish() {
  local name=$1
  demo_git -C "$D/code/$name" add -A
  demo_git -C "$D/code/$name" commit -qm "${2:-Initial version}"
  demo_git init -q --bare "$D/remotes/$name.git"
  demo_git -C "$D/code/$name" remote add origin "$D/remotes/$name.git"
  demo_git -C "$D/code/$name" push -qu origin main
}

setup() {
  [ -e "$D/brain" ] && { echo "$D/brain exists; remove $D first"; exit 1; }
  mkdir -p "$D/skills-home" "$D/worktrees"
  printf '[user]\n\tname = Alex\n\temail = alex@example.com\n[init]\n\tdefaultBranch = main\n' > "$D/gitconfig"

  repo notes-api
  cat > "$D/code/notes-api/package.json" <<'EOF'
{
  "name": "notes-api",
  "version": "2.13.0",
  "type": "module",
  "scripts": { "start": "node src/server.js", "test": "node --test" }
}
EOF
  mkdir -p "$D/code/notes-api/src" "$D/code/notes-api/test"
  cat > "$D/code/notes-api/src/store.js" <<'EOF'
const notes = new Map();
let next = 1;

export function listNotes(query) {
  const all = [...notes.values()];
  if (!query) return all;
  const q = query.toLowerCase();
  return all.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
}

export function getNote(id) {
  return notes.get(id) ?? null;
}

export function addNote({ title, body = '' }) {
  const note = { id: String(next++), title, body, updatedAt: new Date().toISOString() };
  notes.set(note.id, note);
  return note;
}

export function clearNotes() {
  notes.clear();
  next = 1;
}
EOF
  cat > "$D/code/notes-api/src/app.js" <<'EOF'
import { createServer } from 'node:http';
import { addNote, getNote, listNotes } from './store.js';

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/notes') return send(res, 200, listNotes(url.searchParams.get('q')));
    if (req.method === 'POST' && url.pathname === '/notes') {
      const body = await readJson(req);
      if (!body.title) return send(res, 400, { error: 'title_required' });
      return send(res, 201, addNote(body));
    }
    const match = /^\/notes\/(\w+)$/.exec(url.pathname);
    if (req.method === 'GET' && match) {
      const note = getNote(match[1]);
      return note ? send(res, 200, note) : send(res, 404, { error: 'not_found' });
    }
    send(res, 404, { error: 'not_found' });
  });
}
EOF
  cat > "$D/code/notes-api/src/server.js" <<'EOF'
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
createApp().listen(port, () => console.log(`notes-api on http://localhost:${port}`));
EOF
  cat > "$D/code/notes-api/test/notes.test.js" <<'EOF'
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { clearNotes } from '../src/store.js';

const app = createApp().listen(0);
const base = () => `http://localhost:${app.address().port}`;
after(() => app.close());
beforeEach(() => clearNotes());

test('creates and reads a note', async () => {
  const made = await fetch(`${base()}/notes`, { method: 'POST', body: JSON.stringify({ title: 'Groceries' }) });
  assert.equal(made.status, 201);
  const { id } = await made.json();
  const read = await fetch(`${base()}/notes/${id}`);
  assert.equal((await read.json()).title, 'Groceries');
});

test('rejects a note without a title', async () => {
  const res = await fetch(`${base()}/notes`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 400);
});

test('searches titles and bodies', async () => {
  await fetch(`${base()}/notes`, { method: 'POST', body: JSON.stringify({ title: 'Trip', body: 'pack the tent' }) });
  const res = await fetch(`${base()}/notes?q=tent`);
  assert.equal((await res.json()).length, 1);
});
EOF
  printf '# notes-api\n\nA small notes HTTP API. `npm start` serves it on port 3000; `npm test` runs the tests.\n\nRoutes: `GET /health`, `GET /notes?q=`, `POST /notes`, `GET /notes/:id`.\n' > "$D/code/notes-api/README.md"
  printf 'node_modules/\n' > "$D/code/notes-api/.gitignore"
  publish notes-api

  repo notes-web
  mkdir -p "$D/code/notes-web/src/settings"
  printf '# notes-web\n\nThe web app for notes-api. Plain HTML, CSS and JS.\n' > "$D/code/notes-web/README.md"
  printf '{\n  "name": "notes-web",\n  "version": "1.8.0",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' > "$D/code/notes-web/package.json"
  cat > "$D/code/notes-web/src/settings/theme.css" <<'EOF'
:root {
  --surface: #ffffff;
  --surface-raised: #f4f5f7;
  --text: #1c1e21;
  --text-muted: #5f6368;
  --accent: #2f6fde;
}

.settings {
  background: var(--surface);
  color: var(--text);
}
EOF
  printf '<section class="settings">\n  <h1>Settings</h1>\n  <label><input type="checkbox" id="sync"> Sync on mobile data</label>\n</section>\n' > "$D/code/notes-web/src/settings/settings.html"
  publish notes-web

  repo sync-service
  mkdir -p "$D/code/sync-service/src"
  printf '# sync-service\n\nPushes note changes from phones to notes-api and merges offline edits.\n' > "$D/code/sync-service/README.md"
  printf '{\n  "name": "sync-service",\n  "version": "0.9.0",\n  "type": "module"\n}\n' > "$D/code/sync-service/package.json"
  cat > "$D/code/sync-service/src/merge.js" <<'EOF'
export function merge(server, local) {
  const out = { ...server };
  for (const [field, value] of Object.entries(local.fields)) {
    if (!server.changedAt?.[field] || local.changedAt[field] > server.changedAt[field]) out[field] = value;
  }
  return out;
}
EOF
  publish sync-service

  local brain="$D/brain"
  node "$BUILD/dist/daemon/main.js" init --adopt "$brain" --starter "$STARTER" --name Alex --timezone Europe/Berlin
  demo_git -C "$brain" remote set-url starter https://github.com/Harinder441/hos-brain
  demo_git -C "$brain" remote set-url --push starter DISABLED
  node - "$brain/hos/policy.yaml" "$MODEL" <<'EOF'
const [file, model] = process.argv.slice(2);
const fs = require('node:fs');
let text = fs.readFileSync(file, 'utf8');
text = text.replace(/^(models:.*\n)  default: .*\n  effort: .*\n/m, `$1  default: ${model}\n  effort: low\n`);
text = text.replace(/^# repo_roots: .*$/m, `repo_roots: [${process.env.HOS_DEMO_DIR ?? '/tmp/demo'}/code]`);
fs.writeFileSync(file, text);
EOF
  for profile in "$brain"/profiles/*/PROFILE.md; do
    node - "$profile" "$MODEL" <<'EOF'
const fs = require('node:fs');
const [file, model] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, text.replace(/^---\n/, `---\nmodels:\n  claude: { model: ${model}, effort: low }\n`));
EOF
  done
  node - "$brain/shared/USER.md" <<'EOF'
const fs = require('node:fs');
const file = process.argv[2];
let text = fs.readFileSync(file, 'utf8');
text = text.replace(/^- Role:.*$/m, '- Role: backend engineer on a small notes app (notes-api, notes-web, sync-service)');
text = text.replace(/^- How you work:.*$/m, '- How you work: typed; short answers; keep changes small');
text = text.replace(/^- Words that mean something here:.*$/m, '- Words that mean something here: none yet');
fs.writeFileSync(file, text);
EOF
  {
    echo "| notes-api | \`$D/code/notes-api\` | the notes HTTP API, Node; tests: npm test |"
    echo "| notes-web | \`$D/code/notes-web\` | the web app, plain HTML/CSS/JS |"
    echo "| sync-service | \`$D/code/sync-service\` | merges offline edits from phones |"
  } >> "$brain/shared/LOCATIONS.md"
  demo_git -C "$brain" add -A
  demo_git -C "$brain" commit -qm "Make this brain mine"
  echo "demo ready in $D"
}

start() {
  mkdir -p "$D/data"
  cat > "$D/run-daemon.sh" <<EOF
#!/bin/bash
export GIT_CONFIG_GLOBAL=$D/gitconfig GIT_CONFIG_NOSYSTEM=1 HOS_SKILLS_HOME=$D/skills-home HOS_FAKE_GH_DIR=$D/data/gh
cd "$BUILD"
exec node dist/daemon/main.js --port $PORT --data-dir $D/data --brain $D/brain --tmux-socket $D/tmux.sock \\
  --repo-root $D/code --worktree-root $D/worktrees --gh-bin $BUILD/test/fixtures/bin/fake-gh.mjs >> $D/daemon.log 2>&1
EOF
  chmod +x "$D/run-daemon.sh"
  tmux -S "$D/ctl.sock" new-session -d -s daemon "$D/run-daemon.sh"
  until curl -s -o /dev/null "http://127.0.0.1:$PORT/api/doctor"; do sleep 0.3; done
  echo "demo hos on http://localhost:$PORT (data $D/data)"
}

stop() {
  local pid
  pid=$(pgrep -f "dist/daemon/main.js --port $PORT --data-dir $D/data" || true)
  if [ -n "$pid" ]; then
    kill -TERM $pid
    while kill -0 $pid 2>/dev/null; do sleep 0.3; done
  fi
  pkill -f "add-dir=$D/" 2>/dev/null || true
  pkill -f "add-dir=/private$D/" 2>/dev/null || true
  tmux -S "$D/tmux.sock" kill-server 2>/dev/null || true
  tmux -S "$D/ctl.sock" kill-server 2>/dev/null || true
  echo "demo hos stopped"
}

case "${1:-}" in
  setup) setup ;;
  start) start ;;
  stop) stop ;;
  status) curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$PORT/api/doctor" || echo down ;;
  *) echo "usage: $0 setup|start|stop|status"; exit 1 ;;
esac
