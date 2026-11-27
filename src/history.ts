import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { localDate, localTime, zoneLabel } from './owner.js';

export interface HistoryEntry {
  title: string;
  asked: string;
  did: string;
  wrote: string;
  open: string;
}


export function historyPath(brainDir: string, at: number): string {
  const [year, month] = localDate(at).split('-');
  return join(brainDir, 'history', year!, month!, `${localDate(at)}.md`);
}

export function historyBlock(at: number, branch: string, entry: HistoryEntry): string {
  const line = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim() || 'none';
  return [
    `## ${localTime(at)} ${zoneLabel(at)} · ${line(branch)} · ${line(entry.title)}`,
    `- Asked: ${line(entry.asked)}`,
    `- Did: ${line(entry.did)}`,
    `- Wrote: ${line(entry.wrote)}`,
    `- Open: ${line(entry.open)}`,
  ].join('\n');
}

export interface LoggedEntry {
  chatId: string;
  at: number;
  title: string;
  paths: string[];
}

// Every chat in a topic updates PROGRESS.md, so it never ties two entries together.
export function historyPaths(wrote: string): string[] {
  const paths = [...wrote.matchAll(/(?:^|[\s,;(])(\/[^\s,;()/]+\/[^\s,;()]+)/g)].map((m) => m[1]!.replace(/[/.]+$/, ''));
  return [...new Set(paths.filter((p) => basename(p) !== 'PROGRESS.md'))];
}

export function relayEntry(entry: HistoryEntry, logged: LoggedEntry[]): HistoryEntry {
  const theirs = new Set(logged.flatMap((l) => l.paths));
  const own = entry.wrote
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter((item) => item && item !== 'none' && !historyPaths(item).some((p) => theirs.has(p)));
  const refs = logged.map((l) => `chat ${l.chatId.slice(0, 8)} at ${localTime(l.at)} ${zoneLabel(l.at)} ("${l.title.trim()}")`).join('; ');
  return { ...entry, did: `Relays work already logged: ${refs}.`, wrote: own.join(', ') || 'none' };
}

export async function appendHistory(file: string, block: string, date: string): Promise<void> {
  const size = await stat(file).then(
    (s) => s.size,
    () => 0,
  );
  const end = size ? await lastBytes(file, size, 2) : '';
  const lead = !size ? `# ${date}\n\n` : end.endsWith('\n\n') ? '' : end.endsWith('\n') ? '\n' : '\n\n';
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${lead}${block}\n`);
  if (!(await readFile(file, 'utf8')).includes(block)) throw new Error(`${file} does not contain the block after the append`);
}

export async function replaceSections(file: string, text: string, sections: Array<{ name: string; body: string }>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temp, text);
  await rename(temp, file);
  const written = await readFile(file, 'utf8');
  const lost = sections.filter((s) => !written.includes(`## ${s.name}\n\n${s.body}`));
  if (lost.length) throw new Error(`${file} does not hold the ${lost.map((s) => s.name).join(', ')} section(s) after the write`);
}

async function lastBytes(file: string, size: number, count: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const length = Math.min(count, size);
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}
