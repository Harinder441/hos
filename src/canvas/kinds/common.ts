import { z } from 'zod';

export const line = z.string().trim().min(1).max(200);
export const prose = z.string().trim().min(1).max(800);
export const nodeId = z.string().trim().min(1).max(40);

export function plain(text: string): string {
  return text.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
}

export function wrapLabel(label: string, max = 20): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of label.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > max) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...out, line];
}

export function clip(text: string, max = 160): string {
  const flat = plain(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
