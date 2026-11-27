import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// /px0/* are the routes from before the rename; an older viewer binary still posts there.
export const CODE_VIEW_SNAGS_PATHS = ['/hos-code/snags', '/px0/snags'];
export const CODE_VIEW_PR_PATHS = ['/hos-code/pr', '/px0/pr'];
export const CODE_VIEW_REVIEW_PATHS = ['/hos-code/review', '/px0/review'];
export const CODE_VIEW_BASE_PATH = '/hos-code';
const TOKEN_FILE = 'hos-code.token';
const OLD_TOKEN_FILE = 'px0-snags.token';
const LOGIN_TOKEN_FILE = 'hos-code-login.token';
const PR_DIR = 'hos-code-pr';
const OLD_PR_DIR = 'px0-pr';

// The secret hos-code sends to add snags; kept in the data dir so a hand-written ~/.hos-code/hos.env stays valid across restarts.
export function codeViewToken(dataDir: string): { token: string; file: string } {
  const name = moveOnce(dataDir, OLD_TOKEN_FILE, TOKEN_FILE);
  return { token: tokenFile(dataDir, name), file: join(dataDir, name) };
}

export function codeViewLoginToken(dataDir: string): { token: string; file: string } {
  return { token: tokenFile(dataDir, LOGIN_TOKEN_FILE), file: join(dataDir, LOGIN_TOKEN_FILE) };
}

export function codeViewPrDir(dataDir: string): string {
  return join(dataDir, moveOnce(dataDir, OLD_PR_DIR, PR_DIR));
}

// Returns the name to use: the new one, or the old one when it could not be moved.
function moveOnce(dataDir: string, from: string, to: string): string {
  if (!existsSync(join(dataDir, from)) || existsSync(join(dataDir, to))) return to;
  try {
    renameSync(join(dataDir, from), join(dataDir, to));
    return to;
  } catch (error) {
    console.error(`could not move ${from} to ${to} in ${dataDir}`, error);
    return from;
  }
}

export function tokenFile(dataDir: string, name: string): string {
  const file = join(dataDir, name);
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {}
  const token = randomBytes(24).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}
