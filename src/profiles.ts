import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { EFFORTS, type Chat, type Effort, type ProfileInfo, type Task } from './api/types.js';
import { LIVE_STATES } from './governor.js';
import { ownerStart } from './owner.js';
import type { Store } from './store.js';

export const GENERIC = 'generic';
export const PROFILE_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const IDENTITY_FILES = ['SOUL.md', 'USER.md', 'MEMORY.md', 'RULES.md'] as const;
// A chat's return contract, handoff and history run through these, so no profile may hide them.
export const NEVER_HIDDEN = ['complete', 'handoff_ready', 'progress_read', 'progress_update', 'history_append'];

export interface TurnBlockContext {
  store: Store;
  chat: Chat;
  roster: () => string;
  card: (chat: Chat) => string;
}

const BLOCK_LINES = 8;
const LIVE = new Set<string>(LIVE_STATES);
const OPEN_TASKS = new Set<Task['state']>(['open', 'claimed', 'review', 'blocked']);

export const TURN_BLOCKS = {
  roster: ({ roster }) => roster(),
  tasks: ({ store, chat }) => {
    const open = store.tasks(chat.topicId).filter((t) => OPEN_TASKS.has(t.state));
    const who = (t: Task) => (t.claimedBy ? `claimed by ${t.claimedBy === chat.id ? 'you' : t.claimedBy.slice(0, 8)}` : t.state);
    return block('Open tasks (from hos):', open.map((t) => `- ${t.ref} [P${t.priority} ${who(t)}] ${t.title.split('\n')[0]!.slice(0, 100)}`), 'no open tasks');
  },
  workspaces: ({ store, chat }) => {
    const folders = store.getTopic(chat.topicId)!.workspaceIds.flatMap((id) => store.getWorkspace(id) ?? []).filter((w) => w.archivedAt === null);
    return block('Workspaces (from hos):', folders.map((w) => `- ${store.getProject(w.projectId)?.name ?? w.name} · ${w.branch ?? 'no branch'} · ${w.path}`), 'none attached');
  },
  waiting: ({ store, chat }) => {
    const mine = new Set(store.chatsInTopic(chat.topicId).map((c) => c.id));
    const items = store.openInboxItems().filter((item) => item.topicId === chat.topicId || (item.chatId !== null && mine.has(item.chatId)));
    return block(`Waiting for ${ownerStart()} (from hos):`, items.map((item) => `- ${item.kind}: ${item.title.slice(0, 100)}${item.chatId ? ` (chat ${item.chatId.slice(0, 8)})` : ''}`), 'nothing');
  },
  other_topics: ({ store, chat, card }) => {
    const rows = store.listTopics().flatMap((topic) => {
      if (topic.id === chat.topicId || topic.state === 'archived') return [];
      const live = store.chatsInTopic(topic.id).filter((c) => LIVE.has(c.state));
      if (!live.length) return [];
      const cards = live.slice(0, 2).map(card).join(' | ');
      return [`- "${topic.title}" · ${live.length} live · ${cards}`];
    });
    return block('Other topics with live chats (read-only summary, from hos):', rows, 'none');
  },
} satisfies Record<string, (context: TurnBlockContext) => string>;

export type TurnBlock = keyof typeof TURN_BLOCKS;

function block(header: string, lines: string[], empty: string): string {
  if (!lines.length) return `${header} ${empty}`;
  const shown = lines.slice(0, BLOCK_LINES);
  return [header, ...shown, ...(lines.length > shown.length ? [`+${lines.length - shown.length} more`] : [])].join('\n');
}

const names = z.union([z.literal('all'), z.array(z.string().trim().min(1))]);
const FRONTMATTER = z.strictObject({
  description: z.string().trim().min(1),
  skills: names.default('all'),
  can_start: names.default('all'),
  write_scope: z.enum(['any', 'work_dir']).default('any'),
  turn_context: z.array(z.enum(Object.keys(TURN_BLOCKS) as [TurnBlock, ...TurnBlock[]])).default([]),
  handoff_skill: z.string().trim().min(1).default('handoff'),
  handoff_at: z.number().gt(0).lt(1).nullable().default(null),
  context_refresh: z.boolean().default(false),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour like #4f9fd9').nullable().default(null),
  harness: z.string().trim().min(1).nullable().default(null),
  models: z.record(z.string().trim().min(1), z.strictObject({ model: z.string().regex(/^[\w.:-]{1,80}$/, 'must be a model id').optional(), effort: z.enum(EFFORTS).optional() })).default({}),
  hide_tools: z
    .array(z.string().trim().min(1))
    .default([])
    .refine((names) => !names.some((name) => NEVER_HIDDEN.includes(name)), `may not hide ${NEVER_HIDDEN.join(', ')}`),
  browser: z.boolean().default(false),
  picker: z.boolean().default(true),
});

export interface ProfileModel {
  model: string | null;
  effort: Effort | null;
}

export interface Profile {
  id: string;
  description: string;
  skills: 'all' | string[];
  canStart: 'all' | string[];
  writeScope: 'any' | 'work_dir';
  turnContext: TurnBlock[];
  handoffSkill: string;
  handoffAt: number | null;
  contextRefresh: boolean;
  color: string | null;
  harness: string | null;
  models: Record<string, ProfileModel>;
  hideTools: string[];
  browser: boolean;
  picker: boolean;
  body: string;
  identity: Array<{ path: string; text: string }>;
}

export interface ProfileProblem {
  file: string;
  problem: string;
}

export interface Profiles {
  list: Profile[];
  problems: ProfileProblem[];
}

const BUILT_IN_GENERIC: Profile = {
  id: GENERIC,
  description: 'A normal hos chat: every skill, no extra instructions.',
  skills: 'all',
  canStart: 'all',
  writeScope: 'any',
  turnContext: [],
  handoffSkill: 'handoff',
  handoffAt: null,
  contextRefresh: false,
  color: null,
  harness: null,
  models: {},
  hideTools: [],
  browser: false,
  picker: true,
  body: '',
  identity: [],
};

export function loadProfiles(brainDir: string | undefined): Profiles {
  const dir = brainDir ? join(brainDir, 'profiles') : null;
  let entries: Dirent[] = [];
  try {
    entries = dir ? readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : [];
  } catch {
    entries = [];
  }
  const list: Profile[] = [];
  const problems: ProfileProblem[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
      const id = entry.name.replace(/\.md$/, '');
      problems.push({ file: `profiles/${entry.name}`, problem: `old layout: move it to profiles/${id}/PROFILE.md beside ${IDENTITY_FILES.join(', ')}` });
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const file = `profiles/${entry.name}/PROFILE.md`;
    let text: string;
    try {
      text = readFileSync(join(dir!, entry.name, 'PROFILE.md'), 'utf8');
    } catch (error) {
      problems.push({ file, problem: `unreadable: ${(error as Error).message}` });
      continue;
    }
    const parsed = parseProfile(entry.name, text);
    if ('problem' in parsed) {
      problems.push({ file, problem: parsed.problem });
      continue;
    }
    for (const name of IDENTITY_FILES) {
      const path = join(dir!, entry.name, name);
      try {
        parsed.identity.push({ path, text: readFileSync(path, 'utf8') });
      } catch {
        problems.push({ file: `profiles/${entry.name}/${name}`, problem: 'missing, so its chats start without it' });
      }
    }
    list.push(parsed);
  }
  if (!list.some((p) => p.id === GENERIC) && !problems.some((p) => p.file === `profiles/${GENERIC}/PROFILE.md`)) list.push(BUILT_IN_GENERIC);
  list.sort((a, b) => Number(b.id === GENERIC) - Number(a.id === GENERIC) || a.id.localeCompare(b.id));
  return { list, problems };
}

export function parseProfile(id: string, text: string): Profile | { problem: string } {
  if (!PROFILE_ID.test(id)) return { problem: `the folder name must be a lowercase id like lead (letters, digits, -)` };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { problem: 'no frontmatter: the file must start with a --- block that has at least description' };
  let raw: unknown;
  try {
    raw = parse(match[1]!) ?? {};
  } catch (error) {
    return { problem: `frontmatter is not YAML: ${(error as Error).message.split('\n')[0]}` };
  }
  const result = FRONTMATTER.safeParse(raw);
  if (!result.success) return { problem: result.error.issues.map((issue) => `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`).join('; ') };
  const f = result.data;
  return {
    id,
    description: f.description,
    skills: f.skills,
    canStart: f.can_start,
    writeScope: f.write_scope,
    turnContext: f.turn_context,
    handoffSkill: f.handoff_skill,
    handoffAt: f.handoff_at,
    contextRefresh: f.context_refresh,
    color: f.color,
    harness: f.harness,
    models: Object.fromEntries(Object.entries(f.models).map(([harness, pick]) => [harness, { model: pick.model ?? null, effort: pick.effort ?? null }])),
    hideTools: f.hide_tools,
    browser: f.browser,
    picker: f.picker,
    body: match[2]!.trim(),
    identity: [],
  };
}

// A deleted, unknown or broken profile runs as generic; a broken generic.md still leaves the built-in generic.
export function profileFor(profiles: Profiles, id: string): { profile: Profile; notice: string | null } {
  const found = profiles.list.find((p) => p.id === id);
  if (found) return { profile: found, notice: null };
  const generic = profiles.list.find((p) => p.id === GENERIC) ?? BUILT_IN_GENERIC;
  const file = `profiles/${id}/PROFILE.md`;
  const broken = profiles.problems.find((p) => p.file === file);
  const why = broken ? `${file} is broken (${broken.problem})` : `there is no ${file}`;
  return { profile: generic, notice: id === GENERIC ? `${why}, so it runs as the built-in generic` : `this chat's profile "${id}" is unavailable: ${why}, so it runs as ${GENERIC}` };
}

export function profileAppend(profiles: Profiles, profile: Profile): string | undefined {
  const identity = profile.identity.map(({ path, text }) => `Contents of ${path} (profile ${profile.id}):\n\n${text.trim()}`);
  const parts = [...identity, profile.body, profile.id === GENERIC ? '' : profileDirectory(profiles)].filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}

export function allowedSkills(profile: Profile): string[] | undefined {
  return profile.skills === 'all' ? undefined : [...new Set([...profile.skills, profile.handoffSkill])];
}

export function mayStart(profile: Profile, id: string): boolean {
  return profile.canStart === 'all' || profile.canStart.includes(id);
}

export function profileInfo(profile: Profile): ProfileInfo {
  return {
    id: profile.id,
    description: profile.description,
    skills: profile.skills === 'all' ? null : profile.skills.length,
    canStart: profile.canStart,
    contextRefresh: profile.contextRefresh,
    color: profile.color,
    defaults: { harness: profile.harness, models: profile.models },
    browser: profile.browser,
    picker: profile.picker,
  };
}

export function hiddenBuiltIns(profile: Profile): string[] | undefined {
  const names = profile.hideTools.filter((name) => /^[A-Z]/.test(name));
  return names.length ? names : undefined;
}

function profileDirectory(profiles: Profiles): string {
  const rows = profiles.list.map((p) => `| ${p.id} | ${p.description} | ${p.canStart === 'all' ? 'all' : p.canStart.join(', ') || 'none'} |`);
  return ['## hos profiles', 'Start a chat with one of these through spawn profile: <id>.', '', '| id | description | can_start |', '| --- | --- | --- |', ...rows].join('\n');
}
