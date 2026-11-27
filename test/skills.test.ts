import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { hosRoot } from '../src/cli/common.js';
import { hosSkillNames } from '../src/cli/skills.js';
import { frontmatter } from '../src/cli/validate.js';
import { hosVersion, versionInRange } from '../src/cli/version.js';

const root = hosRoot();
const recipesDir = join(root, 'skills', 'hos', 'recipes');

const BRAIN = ['create-a-profile', 'add-a-skill', 'add-a-schedule', 'add-an-action', 'add-a-workspace-rule', 'change-approvals', 'add-repo-locations', 'set-up-phone-access', 'turn-a-correction-into-a-rule', 'update-from-starter'];
const CODE = ['add-a-data-source', 'add-a-harness', 'add-a-transport', 'add-a-setting', 'change-hos'];

test('the 11 hos-owned skills each have a SKILL.md named after their folder, and hos-skills.json lists exactly them', () => {
  const names = hosSkillNames(root);
  const map = JSON.parse(readFileSync(join(root, 'skills', 'hos-skills.json'), 'utf8')) as { skills: Record<string, unknown> };

  expect(names).toEqual(['canvas', 'diagram', 'fresh-chat', 'handoff', 'history', 'hos', 'hos-schedule', 'lead-refresh', 'quick-search', 'restart', 'update-progress']);
  expect(Object.keys(map.skills).sort()).toEqual(names);
  for (const name of names) {
    const front = frontmatter(readFileSync(join(root, 'skills', name, 'SKILL.md'), 'utf8'));
    expect(front.name, name).toBe(name);
    expect(typeof front.description === 'string' && front.description.length > 20, name).toBe(true);
  }
});

test('the hos skill has the 15 recipes, each fits this hos version and names only hos files that exist', () => {
  const files = readdirSync(recipesDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  expect(files.sort()).toEqual([...BRAIN, ...CODE].sort());
  const router = readFileSync(join(root, 'skills', 'hos', 'SKILL.md'), 'utf8');
  const { version } = hosVersion(root);
  for (const id of files) {
    const text = readFileSync(join(recipesDir, `${id}.md`), 'utf8');
    const front = frontmatter(text) as { id?: string; kind?: string; hos?: string; source?: string[]; docs?: string };
    expect(front.id, id).toBe(id);
    expect(front.kind, id).toBe(BRAIN.includes(id) ? 'brain' : 'code');
    expect(versionInRange(version, front.hos ?? ''), `${id} hos: ${front.hos}`).toBe(true);
    expect(Array.isArray(front.source) && front.source.length > 0, id).toBe(true);
    for (const path of front.source ?? []) expect(existsSync(join(root, path)), `${id} source: ${path}`).toBe(true);
    expect(front.docs, id).toMatch(/^[a-z-]+#[a-z0-9-]+$/);
    expect(text, id).toContain('## For the agent');
    expect(router, id).toContain(`\`${id}\``);
  }
});

const slug = (heading: string) =>
  heading
    .replace(/`([^`]*)`/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

function docsAnchors(page: string): Set<string> {
  const headings = [...page.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => slug(m[1]!));
  const ids = [...page.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]!);
  return new Set([...headings, ...ids]);
}

test('every recipe docs: anchor exists on its docs page, as a heading slug or an explicit id', () => {
  const pagesDir = join(root, 'docs', 'site', 'src', 'content', 'docs', 'docs');
  const stale: string[] = [];
  for (const file of readdirSync(recipesDir).filter((f) => f.endsWith('.md'))) {
    const docs = (frontmatter(readFileSync(join(recipesDir, file), 'utf8')) as { docs?: string }).docs ?? '';
    const [page, anchor] = docs.split('#') as [string, string];
    const path = join(pagesDir, `${page}.md`);
    if (!existsSync(path)) stale.push(`${file}: no page ${page}.md`);
    else if (!docsAnchors(readFileSync(path, 'utf8')).has(anchor)) stale.push(`${file}: ${page}.md has no #${anchor}`);
  }
  expect(stale).toEqual([]);
  expect([...docsAnchors('## Set up `hos` phone access!\n<a id="add-repo-locations"></a>\n## Tell hos where\n')]).toEqual(['set-up-hos-phone-access', 'tell-hos-where', 'add-repo-locations']);
});
