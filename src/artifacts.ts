import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { SearchHit } from './api/types.js';

const TEXT_FILES = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.html', '.csv']);
const MAX_FILE_BYTES = 1_000_000;
const SNIPPET_CHARS = 80;

export async function searchWork(brainDir: string, workDir: string, words: string[], limit: number): Promise<SearchHit[]> {
  const needles = words.map((word) => word.toLowerCase());
  const hits: SearchHit[] = [];
  for (const file of await listFiles(workDir)) {
    if (hits.length === limit) break;
    if (!TEXT_FILES.has(extname(file)) || (await stat(file)).size > MAX_FILE_BYTES) continue;
    const text = await readFile(file, 'utf8');
    const lower = text.toLowerCase();
    if (!needles.every((needle) => lower.includes(needle))) continue;
    const at = lower.indexOf(needles[0]!);
    const snippet = text.slice(Math.max(0, at - SNIPPET_CHARS), at + SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
    hits.push({ source: 'artifact', title: relative(brainDir, file), snippet });
  }
  return hits;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
}
