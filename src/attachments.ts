import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { ownerSettings } from './owner.js';
import { canonical } from './policy.js';

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const STAMPED = /^\d{8}-\d{6}-(?:\d+-)?/;

export function attachmentsDir(statusTopic: string): string {
  return posix.join('.context/topics', statusTopic, 'attachments');
}

export function safeName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/'))
    .normalize('NFKC')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .slice(-120);
  return cleaned || 'file';
}

export function unlinkedPath(brainDir: string, path: string): boolean {
  return canonical(join(brainDir, path)) === join(canonical(brainDir), path);
}

export function attachmentName(path: string): string {
  return posix.basename(path).replace(STAMPED, '');
}

function stamp(at: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: ownerSettings().timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

export async function saveAttachment(brainDir: string, statusTopic: string, name: string, data: Buffer, at: number): Promise<{ name: string; path: string }> {
  const dir = attachmentsDir(statusTopic);
  await mkdir(join(brainDir, dir), { recursive: true });
  const safe = safeName(name);
  for (let n = 0; ; n++) {
    const path = posix.join(dir, `${stamp(at)}-${n ? `${n}-` : ''}${safe}`);
    const taken = await stat(join(brainDir, path)).then(() => true, () => false);
    if (taken) continue;
    await writeFile(join(brainDir, path), data, { flag: 'wx' });
    return { name: safe, path };
  }
}
