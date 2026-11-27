import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from 'node:path';
import type { Clock } from './adapters/clock.js';
import { HosError } from './core.js';

const TTL_MS = 60 * 60_000;
const HTML = /\.html?$/i;

export const FILE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export class HtmlFiles {
  private grants = new Map<string, { dir: string; expires: number; canvas: boolean }>();

  constructor(private clock: Clock) {}

  isCanvas(token: string): boolean {
    return this.grants.get(token)?.canvas === true;
  }

  async open(path: string, canvas = false): Promise<{ url: string }> {
    if (!isAbsolute(path) || !HTML.test(path)) throw new HosError(400, 'only an absolute path to an .html or .htm file opens in a tab');
    const file = await realpath(path).catch(() => null);
    if (!file || !HTML.test(file) || !(await stat(file)).isFile()) throw new HosError(404, `no such HTML file: ${path}`);
    const now = this.clock.now();
    for (const [token, grant] of this.grants) if (grant.expires <= now) this.grants.delete(token);
    const token = randomBytes(16).toString('hex');
    this.grants.set(token, { dir: dirname(file), expires: now + TTL_MS, canvas });
    return { url: `/files/${token}/${encodeURIComponent(basename(file))}` };
  }

  async resolve(token: string, rest: string): Promise<string | null> {
    const grant = this.grants.get(token);
    if (!grant || grant.expires <= this.clock.now()) return null;
    const inside = (path: string) => path.startsWith(grant.dir + sep);
    const wanted = normalize(join(grant.dir, rest));
    if (!inside(wanted)) return null;
    const file = await realpath(wanted).catch(() => null);
    if (!file || !inside(file) || !FILE_TYPES[extname(file).toLowerCase()]) return null;
    return (await stat(file)).isFile() ? file : null;
  }
}
