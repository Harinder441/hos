#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const env = process.env;
const fromFile = (name) => (env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`], 'utf8').trim() : null);
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hos-code-argv.log'), `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
appendFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'hos-code-env.log'),
  `${JSON.stringify({
    url: env.HOS_URL ?? null,
    token: env.HOS_CODE_TOKEN ?? null,
    oldToken: env.HOS_PX0_TOKEN ?? null,
    login: env.HOS_CODE_LOGIN_TOKEN ?? null,
    plain: Object.keys(env).filter((key) => /^HOS_(CODE|PX0)_(LOGIN_)?TOKEN$/.test(key)).sort(),
    fromFiles: [fromFile('HOS_CODE_TOKEN'), fromFile('HOS_CODE_LOGIN_TOKEN')],
    github: env.GITHUB_TOKEN ?? null,
  })}\n`,
);
if (/\/pull\/404$/.test(args.at(-1))) {
  console.error('hos-code: github: fetch PR #404: 404 Not Found: Not Found');
  process.exit(1);
}
createServer((req, res) => res.end(`fake hos-code for ${process.cwd()} ${req.url}\n`)).listen(Number(flag('-port')), flag('-host'));
