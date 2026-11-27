import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { hosRoot } from './common.js';
import type { CliResult } from './init.js';

export const LINK_MARKER = '# hos link:';

export interface LinkOptions {
  binDir?: string;
  root?: string;
  node?: string;
  home?: string;
  path?: string;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function defaultBinDir(home = homedir()): string {
  return join(home, '.local', 'bin');
}

export function linkScript(root: string, node: string): string {
  return `#!/bin/sh\n${LINK_MARKER} runs the hos checkout at ${root}; hos unlink removes this file\nexec ${quote(node)} ${quote(join(root, 'dist', 'daemon', 'main.js'))} "$@"\n`;
}

function ours(file: string): boolean {
  return readFileSync(file, 'utf8').split('\n', 3)[1]?.startsWith(LINK_MARKER) ?? false;
}

export function linkHos(options: LinkOptions = {}): CliResult {
  const binDir = resolve(options.binDir ?? defaultBinDir(options.home));
  const root = options.root ?? hosRoot();
  const file = join(binDir, 'hos');
  if (!existsSync(join(root, 'dist', 'daemon', 'main.js'))) return { ok: false, lines: [`${root} has no dist/daemon/main.js yet; run npm run build there first`] };
  if (existsSync(file) && !ours(file)) return { ok: false, lines: [`${file} exists and hos did not write it; move it away or pass --bin-dir <another folder>`] };
  const existed = existsSync(file);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(file, linkScript(root, options.node ?? process.execPath));
  chmodSync(file, 0o755);
  const onPath = (options.path ?? process.env.PATH ?? '').split(delimiter).some((dir) => dir && resolve(dir) === binDir);
  return {
    ok: true,
    lines: [
      `${existed ? 'updated' : 'linked '} ${file} → ${join(root, 'dist', 'daemon', 'main.js')}`,
      onPath
        ? `on PATH: ${binDir}`
        : `not on PATH: ${binDir}. Add this line to your shell's startup file (~/.zshrc or ~/.bashrc), then open a new terminal: export PATH="${binDir}:$PATH"`,
    ],
  };
}

export function unlinkHos(options: LinkOptions = {}): CliResult {
  const file = join(resolve(options.binDir ?? defaultBinDir(options.home)), 'hos');
  if (!existsSync(file)) return { ok: true, lines: [`nothing to remove: no ${file}`] };
  if (!ours(file)) return { ok: false, lines: [`${file} was not written by hos link, so it was left alone`] };
  rmSync(file);
  return { ok: true, lines: [`removed ${file}`] };
}
