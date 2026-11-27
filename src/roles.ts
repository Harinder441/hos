import { realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Project } from './api/types.js';
import { EDIT_TOOL_FIELDS } from './harnesses/tools.js';

export interface ProjectChoice {
  project: Project;
  about: string;
}

export type Resolution = { project: Project } | { candidates: ProjectChoice[] };

export function resolveProject(query: string, choices: ProjectChoice[]): Resolution {
  const q = query.trim();
  const lower = q.toLowerCase();
  const path = isAbsolute(q) || q.startsWith('~/') ? realPath(resolve(q.replace(/^~(?=\/)/, homedir()))) : null;
  const exact = choices.filter(
    ({ project }) =>
      project.id === q || project.path === path || project.key?.toLowerCase() === lower || project.name.toLowerCase() === lower,
  );
  if (exact.length === 1) return { project: exact[0]!.project };
  const asked = words(q);
  if (!asked.length) return { candidates: [] };
  const matches = choices.filter(({ project, about }) => {
    const known = words(`${project.key ?? ''} ${project.name} ${basename(project.path)} ${about}`);
    return asked.every((word) => known.some((k) => k.startsWith(word)));
  });
  return matches.length === 1 ? { project: matches[0]!.project } : { candidates: matches };
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function isImplement(text: string): boolean {
  const said = text.trim();
  return /^implement\b/i.test(said) && !said.endsWith('?');
}

export function isEditTool(tool: string): boolean {
  return tool in EDIT_TOOL_FIELDS;
}
