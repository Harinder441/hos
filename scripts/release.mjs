#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const DOCS_PROMPT_FILES = ['docs/site/src/content/docs/docs/install.md', 'docs/site/src/pages/index.astro'];
const RAW_URL = /https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[^/\s]+\/install\/INSTALL\.md/g;
const HASH = /(check that its SHA-256 is )(<span class="p">)?(?:&lt;hash&gt;|<hash>|[0-9a-f]{64})(<\/span>)?/g;
const MARKER = /^[ \t]*<!-- TODO-T19:[^\n]*-->\n/gm;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function installUrl(repo, tag) {
  return `https://raw.githubusercontent.com/${repo}/${tag}/install/INSTALL.md`;
}

export function promptText(repo, tag, hash) {
  return `Install hos on this computer. Download ${installUrl(repo, tag)} with curl, check that its SHA-256 is ${hash}, and stop if it is not. Tell me in five lines what it will change, then follow it exactly.`;
}

export function writePrompt(text, repo, tag, hash) {
  const urls = text.match(RAW_URL)?.length ?? 0;
  const hashes = text.match(HASH)?.length ?? 0;
  if (!urls || urls !== hashes) throw new Error(`expected the install prompt (one INSTALL.md URL and one "check that its SHA-256 is" per prompt), found ${urls} URL(s) and ${hashes} hash slot(s)`);
  return text
    .replace(RAW_URL, installUrl(repo, tag))
    .replace(HASH, (_m, lead, open, close) => `${lead}${open ?? ''}${hash}${close ?? ''}`)
    .replace(MARKER, '');
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function release({ root, tag, out, repo = 'Harinder441/hos' }) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (tag !== `v${version}`) throw new Error(`--tag ${tag} does not match package.json version ${version} (expected v${version})`);
  const lines = [];
  let tagged = false;
  try {
    tagged = git(root, 'rev-parse', `${tag}^{commit}`) === git(root, 'rev-parse', 'HEAD');
    if (!tagged) throw new Error(`${tag} exists but is not HEAD; check out ${tag} before building its release`);
  } catch (error) {
    if (String(error.message).includes('is not HEAD')) throw error;
    lines.push(`tag     ${tag} does not exist yet: build-only, nothing is tagged or published`);
  }

  const install = readFileSync(join(root, 'install', 'INSTALL.md'));
  const hash = sha256(install);
  for (const file of DOCS_PROMPT_FILES) {
    const path = join(root, file);
    writeFileSync(path, writePrompt(readFileSync(path, 'utf8'), repo, tag, hash));
    lines.push(`docs    ${file}: prompt pinned to ${tag}, SHA-256 ${hash}`);
  }
  const left = files(join(root, 'docs', 'site', 'src')).filter((f) => readFileSync(f, 'utf8').includes('TODO-T19'));
  if (left.length) throw new Error(`TODO-T19 still in ${left.map((f) => relative(root, f)).join(', ')}`);

  mkdirSync(out, { recursive: true });
  copyFileSync(join(root, 'install', 'INSTALL.md'), join(out, 'INSTALL.md'));
  writeFileSync(join(out, 'INSTALL.md.sha256'), `${hash}  INSTALL.md\n`);
  writeFileSync(join(out, 'prompt.txt'), `${promptText(repo, tag, hash)}\n`);
  const tarball = `hos-${version}.tar.gz`;
  execFileSync('git', ['archive', '--format=tar.gz', `--prefix=hos-${version}/`, '-o', join(out, tarball), 'HEAD'], { cwd: root });
  writeSums(out);
  lines.push(`out     ${out}: INSTALL.md, INSTALL.md.sha256, prompt.txt, ${tarball}, SHA256SUMS`, `prompt  ${promptText(repo, tag, hash)}`);
  return { hash, tagged, lines };
}

export function writeSums(out) {
  const names = readdirSync(out).filter((n) => n !== 'SHA256SUMS' && statSync(join(out, n)).isFile()).sort();
  writeFileSync(join(out, 'SHA256SUMS'), names.map((n) => `${sha256(readFileSync(join(out, n)))}  ${n}\n`).join(''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { tag: { type: 'string' }, out: { type: 'string', default: 'release' }, repo: { type: 'string' }, sums: { type: 'boolean', default: false } } });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    if (values.sums) {
      writeSums(resolve(values.out));
      console.log(`SHA256SUMS written in ${resolve(values.out)}`);
    } else {
      if (!values.tag) throw new Error('usage: node scripts/release.mjs --tag v<package.json version> [--out <dir>] [--repo <owner/name>]  |  --sums [--out <dir>]');
      const result = release({ root, tag: values.tag, out: resolve(values.out), ...(values.repo ? { repo: values.repo } : {}) });
      console.log(result.lines.join('\n'));
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
