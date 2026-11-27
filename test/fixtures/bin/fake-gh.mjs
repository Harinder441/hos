#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dir = process.env.HOS_FAKE_GH_DIR ?? join(tmpdir(), 'hos-fake-gh');
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, 'gh-argv.log'), `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
const file = join(dir, 'gh-prs.json');
const prs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const head = args[args.indexOf('--head') + 1];
const key = `${process.cwd()}#${head}`;

if (args[0] === 'pr' && args[1] === 'list') {
  console.log(JSON.stringify(prs[key] ? [{ number: prs[key] }] : []));
} else if (args[0] === 'pr' && args[1] === 'create') {
  prs[key] ??= Object.keys(prs).length + 1;
  writeFileSync(file, JSON.stringify(prs));
  console.log(`https://github.com/hos-e2e/fake/pull/${prs[key]}`);
} else {
  console.error(`fake gh: unsupported ${args.join(' ')}`);
  process.exit(1);
}
