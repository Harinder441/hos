import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK = 'hos-full-suite';
const POLL_MS = 2000;

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

async function holders(url, token, here) {
  try {
    const res = await fetch(`${url}/local/locks?pattern=${LOCK}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    return (await res.json()).holders.filter((h) => h.root && real(h.root) !== here);
  } catch {
    return [];
  }
}

export async function waitForFullSuite() {
  let token;
  try {
    token = readFileSync(join(process.env.HOS_DATA_DIR ?? join(homedir(), '.hos'), 'local-ops.token'), 'utf8').trim();
  } catch {
    return;
  }
  const url = process.env.HOS_URL ?? 'http://127.0.0.1:4517';
  const here = real(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  let held = await holders(url, token, here);
  if (held.length) console.log(`waiting: ${held[0].holder}; checks run when it unlocks`);
  while (held.length) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    held = await holders(url, token, here);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await waitForFullSuite();
