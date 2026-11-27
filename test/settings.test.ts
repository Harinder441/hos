import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { SettingsPage } from '../src/api/types.js';
import { cleanupAll, startTestDaemon, tempDir } from './harness.js';

afterEach(cleanupAll);

const POLICY = `version: 1  # schema version
context:  # context lifecycle
  nudge: 150000  # tells the chat to finish its step
  handoff: 180000  # blocks Stop until a handoff is written
slots:  # what may run at once
  claude_running: 6  # running Claude chats
approvals:  # nothing asks
  A0: { name: read, lane_t: auto }  # reads change nothing
${['A1', 'A2', 'A3', 'A4'].map((c) => `  ${c}: { lane_t: auto }\n`).join('')}  A5: { name: publish, lane_t: auto }  # push and PR run without asking
${['A6', 'A6b', 'A7', 'A8'].map((c) => `  ${c}: { lane_t: auto }\n`).join('')}  unclassified: auto  # a call hos can't classify runs
models:  # the composer's model menu
  default: claude-opus-5-5  # used for new chats
  effort: high
  list:
    - { id: claude-opus-5-5, label: Opus 5.5 }
    - { id: claude-haiku-5-5, label: Haiku 5.5 }  # the fast one
transport: tailscale  # tailnet only
ports:  # per-worktree ports
  from: 4100  # above the dev defaults
  to: 4999
`;

async function brain(policy: string | null): Promise<string> {
  const dir = await tempDir('hos-brain-');
  await mkdir(join(dir, 'hos'));
  if (policy !== null) await writeFile(join(dir, 'hos', 'policy.yaml'), policy);
  await writeFile(
    join(dir, 'hos', 'actions.yaml'),
    `version: 1
setup:
  run: bash scripts/setup.sh
  does: Copies .env files into a new worktree
actions:
  - name: preview  # Code view links
    run: bash scripts/preview.sh .
    where: host
    cwd: worktree
    confirm: false
`,
  );
  await writeFile(join(dir, 'hos', 'workspace-rules.yaml'), 'rules:\n  - repo: pp-notes\n    use: root\n    reason: a knowledge store, edited on main\n');
  return dir;
}

const section = (page: SettingsPage, id: string) => page.sections.find((s) => s.id === id)!;
const row = (page: SettingsPage, id: string, key: string) => section(page, id).settings.find((s) => s.key === key);

test('GET /api/settings lists the 11 sections in order, each with its one-line purpose, and every setting with its value, yaml comment and whether it needs a restart', async () => {
  const brainDir = await brain(`${POLICY}owner:\n  name: Sam\n  timezone: Europe/Berlin\nrepo_roots: [~/code]  # where my repos live\nevents:\n  retention_days: 30\ncustom_thing: 3  # something hos does not know\n`);
  const repoRoot = await tempDir('hos-code-');
  const hos = await startTestDaemon({ brainDir, discovery: { repoRoots: [repoRoot] } });

  const page = await hos.client.settings();

  expect(page.sections.map((s) => s.title)).toEqual([
    'Doctor',
    'Projects',
    'Models & agents',
    'Profiles',
    'Approvals',
    'Workspaces',
    'Schedules',
    'Phone & remote access',
    'Computers',
    'Storage & integrations',
    'Advanced',
  ]);
  expect(page.sections.every((s) => s.what && s.what.endsWith('.'))).toBe(true);
  expect(row(page, 'doctor', 'Brain folder')).toMatchObject({ value: brainDir });
  expect(row(page, 'projects', 'Folders to search')).toEqual({ key: 'Folders to search', value: repoRoot, description: 'where my repos live', restart: true });
  expect(row(page, 'agents', 'Scripted')).toMatchObject({ value: 'signed in' });
  expect(row(page, 'agents', 'Haiku 5.5')).toEqual({ key: 'Haiku 5.5', value: 'claude-haiku-5-5', description: 'the fast one' });
  expect(row(page, 'agents', 'slots.claude_running')).toEqual({ key: 'slots.claude_running', value: '6', description: 'running Claude chats' });
  expect(section(page, 'approvals').note).toMatch(/^Chats never ask/);
  expect(row(page, 'approvals', 'Preset')).toMatchObject({ value: 'Your own rules' });
  expect(row(page, 'approvals', 'Publish: push, open a pull request, deploy')).toEqual({ key: 'Publish: push, open a pull request, deploy', value: 'Runs', description: 'approvals.A5' });
  expect(section(page, 'workspaces').settings).toEqual([
    { key: 'Ports for dev servers', value: '4100–4999', description: 'each worktree gets its own port from this range', restart: true },
    { key: 'setup.run', value: 'bash scripts/setup.sh', description: '' },
    { key: 'setup.does', value: 'Copies .env files into a new worktree', description: '' },
    { key: 'preview', value: 'bash scripts/preview.sh .', description: 'Code view links · host' },
    { key: 'pp-notes', value: 'root', description: 'a knowledge store, edited on main' },
  ]);
  expect(row(page, 'remote', 'How you reach this computer')).toMatchObject({ restart: true });
  expect(row(page, 'remote', 'Daemon port')).toMatchObject({ value: String(hos.daemon.port), restart: true });
  expect(row(page, 'storage', 'Snags')).toMatchObject({ value: 'This computer' });
  expect(row(page, 'storage', 'Calendar')).toMatchObject({ value: 'none' });
  expect(row(page, 'advanced', 'Your name')).toMatchObject({ value: 'Sam', restart: true });
  expect(row(page, 'advanced', 'Time zone')?.value).toMatch(/^Europe\/Berlin \(/);
  expect(row(page, 'advanced', 'Keep reasoning traces for')).toMatchObject({ value: '30 days' });
  expect(row(page, 'advanced', 'context.nudge')).toEqual({ key: 'context.nudge', value: '150000', description: 'tells the chat to finish its step' });
  expect(row(page, 'advanced', 'custom_thing')).toEqual({ key: 'custom_thing', value: '3', description: 'something hos does not know' });
});

test('with no models or approvals block the page shows the built-in model list and the Balanced preset, and an edit to policy.yaml shows on the next read', async () => {
  const brainDir = await brain('version: 1\n');
  const hos = await startTestDaemon({ brainDir });

  const before = await hos.client.settings();
  expect(section(before, 'agents').settings.filter((s) => s.value.startsWith('claude-')).map((s) => [s.key, s.value])).toEqual([
    ['default', 'claude-opus-5-5'],
    ['Opus 5.5', 'claude-opus-5-5'],
    ['Sonnet 5.5', 'claude-sonnet-5-5'],
    ['Haiku 5.5', 'claude-haiku-5-5'],
  ]);
  expect(row(before, 'approvals', 'Preset')).toMatchObject({ value: 'Balanced' });
  expect(section(before, 'approvals').settings.map((s) => s.value).slice(1)).toEqual([
    'Runs',
    'Runs',
    'Asks',
    'Runs',
    'Asks',
    'Asks every time',
    'Asks every time',
    'Asks every time',
    'Asks',
    'Asks every time',
    'Asks',
    'Asks',
    'Asks',
  ]);
  expect(row(before, 'approvals', 'Change plug-in code, the plugins list or harnesses')).toMatchObject({
    value: 'Asks',
    description: 'approvals.plugin_edits: follow, the default (follow uses the Change hos settings, profiles and skills row)',
  });
  expect(row(before, 'advanced', 'Keep reasoning traces for')).toMatchObject({ value: 'forever' });

  await writeFile(join(brainDir, 'hos', 'policy.yaml'), POLICY.replace('default: claude-opus-5-5', 'default: claude-haiku-5-5'));
  const after = await hos.client.settings();
  expect(row(after, 'agents', 'default')).toMatchObject({ value: 'claude-haiku-5-5' });
});
