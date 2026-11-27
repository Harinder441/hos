import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { SkillInfo } from './api/types.js';

export function listSkills(brainDir: string | undefined, home: string): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const root of [join(home, '.claude', 'skills'), ...(brainDir ? [join(brainDir, '.claude', 'skills')] : [])]) {
    for (const skill of readSkills(root)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readSkills(root: string): SkillInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries.flatMap((dir) => {
    let text: string;
    try {
      text = readFileSync(join(root, dir, 'SKILL.md'), 'utf8');
    } catch {
      return [];
    }
    const front = frontmatter(text);
    const name = typeof front.name === 'string' && front.name.trim() ? front.name.trim() : dir;
    const description = typeof front.description === 'string' ? front.description.trim() : '';
    return [{ name, description }];
  });
}

function frontmatter(text: string): Record<string, unknown> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!block) return {};
  try {
    const doc = parse(block) as unknown;
    return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
