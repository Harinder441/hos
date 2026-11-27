import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { brainUpdate } from '../src/cli/brain-update.js';
import { hosRoot } from '../src/cli/common.js';
import { adoptBrain, STARTER_URL } from '../src/cli/init.js';
import { MANIFEST, syncSkills } from '../src/cli/skills.js';
import { validateBrain } from '../src/cli/validate.js';
import { versionInRange, versionLine } from '../src/cli/version.js';
import { SnagsClient } from '../src/snags/client.js';
import { cleanupAll, git, startTestDaemon, tempDir } from './harness.js';

afterEach(cleanupAll);

const identity = (repo: string) => {
  git(repo, 'config', 'user.name', 'hos-test');
  git(repo, 'config', 'user.email', 'hos@test.invalid');
};

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const profile = (front: string) => ({ 'PROFILE.md': `---\n${front}\n---\n# body\n`, 'SOUL.md': '# soul\n', 'USER.md': '# user\n', 'MEMORY.md': '# memory\n', 'RULES.md': '# rules\n' });
const profileFiles = (id: string, front: string) => Object.fromEntries(Object.entries(profile(front)).map(([name, text]) => [`profiles/${id}/${name}`, text]));

async function hosRootWith(skills: Record<string, string>, map: Record<string, string[]>): Promise<string> {
  const root = await tempDir('hos-root-');
  write(root, { 'package.json': JSON.stringify({ name: 'hos', version: '0.3.1' }) });
  cpSync(join(hosRoot(), 'schemas'), join(root, 'schemas'), { recursive: true });
  write(root, Object.fromEntries(Object.entries(skills).map(([path, text]) => [`skills/${path}`, text])));
  write(root, { 'skills/hos-skills.json': JSON.stringify({ skills: Object.fromEntries(Object.entries(map).map(([s, profiles]) => [s, { profiles }])) }) });
  return root;
}

async function starterRepo(): Promise<string> {
  const dir = await tempDir('hos-starter-');
  git(dir, 'init', '-q', '-b', 'starter');
  write(dir, {
    'CLAUDE.md': '@AGENTS.md\n@shared/USER.md\n',
    'AGENTS.md': '# rules\n',
    'shared/USER.md': '# USER\n\n- Name: <your name>\n- Timezone: <IANA zone, e.g. Europe/Berlin>\n- Role: <what you build>\n',
    'hos/policy.yaml': '# hos policy\nversion: 1  # schema version\n\nevents:\n  retention_days: 30  # keep a month\n',
    '.claude/skills/work-in/SKILL.md': '---\nname: work-in\ndescription: route\n---\n',
    ...profileFiles('generic', 'description: every skill'),
    ...profileFiles('lead', "description: runs a topic\nskills:\n  - work-in\ncan_start: [generic]\ncolor: '#d9a441'"),
  });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'starter v1');
  return dir;
}

const SKILLS = {
  'handoff/SKILL.md': '---\nname: handoff\ndescription: hand off\n---\nv1\n',
  'handoff/references/template.md': 'template v1\n',
  'history/SKILL.md': '---\nname: history\ndescription: log\n---\n',
};

test('hos --version names the package version and the checkout commit', () => {
  expect(versionLine()).toMatch(/^hos \d+\.\d+\.\d+( \([0-9a-f]{4,}\))?$/);
  expect(versionInRange('0.3.1', '>=0.1')).toBe(true);
  expect(versionInRange('0.3.1', '>=0.1 <0.3')).toBe(false);
});

test('hos init --adopt clones the starter fetch-only, adds the user’s origin, fills in the owner, installs hos skills and appends them to listed profiles', async () => {
  const root = await hosRootWith(SKILLS, { handoff: ['lead', 'engineer'], history: ['ritual'] });
  const starter = await starterRepo();
  const brain = join(await tempDir('hos-home-'), 'hos-brain');

  const result = adoptBrain({ dir: brain, starter, origin: 'git@example.com:me/hos-brain.git', name: 'Asha', timezone: 'Europe/Berlin', root, home: brain });

  expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
  expect(result.ok).toBe(true);
  expect(git(brain, 'branch', '--show-current')).toBe('main');
  expect(git(brain, 'remote', 'get-url', 'starter')).toBe(starter);
  expect(git(brain, 'remote', 'get-url', '--push', 'starter')).toBe('DISABLED');
  expect(git(brain, 'remote', 'get-url', 'origin')).toBe('git@example.com:me/hos-brain.git');
  expect(readFileSync(join(brain, 'hos', 'policy.yaml'), 'utf8')).toBe(
    '# hos policy\nversion: 1  # schema version\n\nevents:\n  retention_days: 30  # keep a month\n\nowner:  # who these agents work for (hos init wrote it)\n  name: Asha\n  timezone: Europe/Berlin\n',
  );
  expect(readFileSync(join(brain, 'shared', 'USER.md'), 'utf8')).toContain('- Name: Asha\n- Timezone: Europe/Berlin\n- Role: <what you build>');
  expect(readFileSync(join(brain, '.claude/skills/handoff/references/template.md'), 'utf8')).toBe('template v1\n');
  const lead = readFileSync(join(brain, 'profiles/lead/PROFILE.md'), 'utf8');
  expect(lead).toBe("---\ndescription: runs a topic\nskills:\n  - work-in\n  - handoff\ncan_start: [generic]\ncolor: '#d9a441'\n---\n# body\n");
  expect(readFileSync(join(brain, 'profiles/generic/PROFILE.md'), 'utf8')).toBe('---\ndescription: every skill\n---\n# body\n');
  expect(result.lines).toContain('ok    profiles/lead/PROFILE.md');
});

test('hos init --adopt never puts back a hos skill the user took out of a profile, and runs again without changes', async () => {
  const root = await hosRootWith(SKILLS, { handoff: ['lead'] });
  const brain = join(await tempDir('hos-home-'), 'hos-brain');
  adoptBrain({ dir: brain, starter: await starterRepo(), root, home: brain });
  const file = join(brain, 'profiles/lead/PROFILE.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('  - handoff\n', ''));
  const edited = readFileSync(file, 'utf8');

  const policy = join(brain, 'hos', 'policy.yaml');
  writeFileSync(policy, 'version: 1\nowner:  # me\n  name: Asha  # first name\n  words: [Asha]\nplugins: []  # none\n');

  const again = adoptBrain({ dir: brain, name: 'Asha K', timezone: 'Asia/Tokyo', root, home: brain });

  expect(again.ok).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(edited);
  expect(again.lines.some((l) => l.startsWith('profile '))).toBe(false);
  expect(readFileSync(policy, 'utf8')).toBe('version: 1\nowner:  # me\n  name: Asha K\n  words: [Asha]\n  timezone: Asia/Tokyo\nplugins: []  # none\n');
});

test('hos init --adopt refuses a bad timezone and an origin that already points elsewhere', async () => {
  const root = await hosRootWith(SKILLS, {});
  const brain = join(await tempDir('hos-home-'), 'hos-brain');
  expect(adoptBrain({ dir: brain, starter: await starterRepo(), timezone: 'Mars/Olympus', root }).lines.at(-1)).toContain('not an IANA zone');
  expect(existsSync(brain)).toBe(false);
  adoptBrain({ dir: brain, starter: await starterRepo(), origin: 'https://example.com/a.git', root, home: brain });
  const result = adoptBrain({ dir: brain, origin: 'https://example.com/b.git', root, home: brain });
  expect(result.ok).toBe(false);
  expect(result.lines.at(-1)).toContain('origin already points at https://example.com/a.git');
});

test('hos init --adopt on a clone of the user’s own brain leaves its origin alone and adds starter; it renames origin only when origin is the starter', async () => {
  const root = await hosRootWith(SKILLS, {});
  const own = await tempDir('hos-own-');
  git(own, 'clone', '-q', await starterRepo(), 'brain');
  const brain = join(own, 'brain');
  git(brain, 'remote', 'set-url', 'origin', 'git@example.com:me/my-brain.git');

  const result = adoptBrain({ dir: brain, root, home: brain });

  expect(result.ok).toBe(true);
  expect(git(brain, 'remote', 'get-url', 'origin')).toBe('git@example.com:me/my-brain.git');
  expect(git(brain, 'remote', 'get-url', '--push', 'origin')).toBe('git@example.com:me/my-brain.git');
  expect(git(brain, 'remote', 'get-url', 'starter')).toBe(STARTER_URL);
  expect(git(brain, 'remote', 'get-url', '--push', 'starter')).toBe('DISABLED');

  const starter = await starterRepo();
  const plain = await tempDir('hos-plain-');
  git(plain, 'clone', '-q', starter, 'brain');
  adoptBrain({ dir: join(plain, 'brain'), starter, root, home: plain });
  expect(git(join(plain, 'brain'), 'remote')).toBe('starter');
  expect(git(join(plain, 'brain'), 'remote', 'get-url', '--push', 'starter')).toBe('DISABLED');
});

test('hos init --adopt refuses a folder that sits inside another git repository and leaves that repository alone', async () => {
  const root = await hosRootWith(SKILLS, {});
  const outer = await starterRepo();
  git(outer, 'remote', 'add', 'origin', 'git@example.com:me/outer.git');
  mkdirSync(join(outer, 'inner'));

  const result = adoptBrain({ dir: join(outer, 'inner'), root, home: outer });

  expect(result.ok).toBe(false);
  expect(result.lines.at(-1)).toContain('is not the top folder of its own git repository');
  expect(git(outer, 'remote')).toBe('origin');
  expect(git(outer, 'remote', 'get-url', '--push', 'origin')).toBe('git@example.com:me/outer.git');
  expect(git(outer, 'status', '--porcelain')).toBe('');
});

test('a chat gets the brain folder as HOS_BRAIN, and the Doctor’s broken-profile row names a validate command that runs', async () => {
  const brain = await starterRepo();
  write(brain, profileFiles('broken', 'description: broken\nnot_a_key: 1'));
  const hos = await startTestDaemon({ brainDir: brain, script: (input) => [{ delta: `Got: ${input}` }] });
  const { chatId } = await hos.client.startTopic({ text: 'hello' });
  await expect.poll(() => hos.agentRuntime.started.some((s) => s.chatId === chatId)).toBe(true);

  expect(hos.agentRuntime.started.find((s) => s.chatId === chatId)!.env).toMatchObject({ HOS_BRAIN: brain });
  const row = (await hos.client.doctorChecks()).find((c) => c.id === 'profile:profiles/broken/PROFILE.md');
  expect(row?.fix).toBe(`fix the brain's profiles/broken/PROFILE.md, then run node ${join(hosRoot(), 'dist', 'daemon', 'main.js')} validate --brain ${brain}`);
  write(brain, { 'hos/validate.mjs': '' });
  expect((await hos.client.doctorChecks()).find((c) => c.id === 'profile:profiles/broken/PROFILE.md')?.fix).toBe("fix the brain's profiles/broken/PROFILE.md, then run node hos/validate.mjs");
});

test('hos skills sync adds, updates and removes hos-written files, and keeps a file the user edited or wrote', async () => {
  const brain = await tempDir('hos-brain-');
  const v1 = await hosRootWith(SKILLS, {});
  expect(syncSkills(brain, { root: v1 }).added).toEqual(['handoff/SKILL.md', 'handoff/references/template.md', 'history/SKILL.md']);
  writeFileSync(join(brain, '.claude/skills/handoff/references/template.md'), 'my own template\n');
  write(brain, { '.claude/skills/history/SKILL.md': '---\nname: history\n---\nmine\n' });
  const manifest = JSON.parse(readFileSync(join(brain, '.claude/skills', MANIFEST), 'utf8')) as { files: Record<string, string> };
  delete manifest.files['history/SKILL.md'];
  writeFileSync(join(brain, '.claude/skills', MANIFEST), JSON.stringify(manifest));

  const v2 = await hosRootWith({ 'handoff/SKILL.md': '---\nname: handoff\ndescription: hand off\n---\nv2\n', 'handoff/references/template.md': 'template v2\n', 'history/SKILL.md': SKILLS['history/SKILL.md'] }, {});
  const dry = syncSkills(brain, { root: v2, dryRun: true });
  expect(readFileSync(join(brain, '.claude/skills/handoff/SKILL.md'), 'utf8')).toContain('v1');
  const report = syncSkills(brain, { root: v2 });

  expect(dry).toEqual(report);
  expect(report).toMatchObject({ updated: ['handoff/SKILL.md'], edited: ['handoff/references/template.md'], unmanaged: ['history/SKILL.md'] });
  expect(readFileSync(join(brain, '.claude/skills/handoff/SKILL.md'), 'utf8')).toContain('v2');
  expect(readFileSync(join(brain, '.claude/skills/handoff/references/template.md'), 'utf8')).toBe('my own template\n');
  expect(readFileSync(join(brain, '.claude/skills/history/SKILL.md'), 'utf8')).toContain('mine');
  expect(syncSkills(brain, { root: v2 }).edited).toEqual(['handoff/references/template.md']);

  const v3 = await hosRootWith({ 'history/SKILL.md': SKILLS['history/SKILL.md'] }, {});
  expect(syncSkills(brain, { root: v3 })).toMatchObject({ removed: ['handoff/SKILL.md'], edited: ['handoff/references/template.md'] });
  expect(existsSync(join(brain, '.claude/skills/handoff/SKILL.md'))).toBe(false);
});

test('hos validate passes a starter-shaped brain, warns about keys hos no longer reads and fails what the daemon would refuse', async () => {
  const root = await hosRootWith(SKILLS, {});
  const brain = await starterRepo();
  write(brain, { 'hos/policy.yaml': 'version: 1\nisolation: off\ncell_egress: []\napprovals:\n' + ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A6b', 'A7', 'A8'].map((c) => `  ${c}: { lane_t: ask, tainted: deny }\n`).join('') });
  const passed = validateBrain(brain, { root, home: brain });
  expect(passed.ok).toBe(true);
  expect(passed.lines).toContain('warn  hos/policy.yaml: approvals.*.tainted (10 places): hos no longer reads this key (taint is gone); delete it');
  expect(passed.lines).toContain('warn  hos/policy.yaml: isolation: hos no longer reads this key (cells and taint are gone); delete it');

  write(brain, {
    'hos/policy.yaml': 'version: 1\nowner: { timezone: Mars/Olympus }\ntransport: carrier-pigeon\n',
    ...profileFiles('lead', 'description: runs a topic\nskills: [work-in, handoff, nope]'),
    'CLAUDE.md': '@AGENTS.md\n@shared/GONE.md\n',
  });
  const failed = validateBrain(brain, { root, home: brain });
  expect(failed.ok).toBe(false);
  expect(failed.lines).toContain('FAIL  hos/policy.yaml: transport: must be one of tailscale, cloudflare');
  expect(failed.lines).toContain('FAIL  profiles/lead/PROFILE.md: skills: "handoff" is a hos skill that is not in .claude/skills yet; run hos skills sync');
  expect(failed.lines).toContain('FAIL  profiles/lead/PROFILE.md: skills: "nope" is not installed in .claude/skills');
  expect(failed.lines).toContain('warn  CLAUDE.md: @shared/GONE.md does not exist, so chats load nothing for that line');

  write(brain, { 'hos/policy.yaml': 'version: 1\nowner: { timezone: Mars/Olympus }\n' });
  expect(validateBrain(brain, { root, home: brain }).lines).toContain('FAIL  hos/policy.yaml: owner.timezone must be an IANA zone like Europe/Berlin');
});

test('hos validate accepts an approvals preset in place of the class rows, plugin_edits, read_only_mcp and script_classes, and fails values hos would refuse', async () => {
  const root = await hosRootWith(SKILLS, {});
  const brain = await starterRepo();
  write(brain, { 'hos/policy.yaml': 'version: 1\napprovals:\n  preset: balanced\n  plugin_edits: ask_every_time\n  A4: { lane_t: auto }\nread_only_mcp: [docs]\nscript_classes:\n  deploy/: A5\n' });
  expect(validateBrain(brain, { root, home: brain }).lines).toContain('ok    hos/policy.yaml');

  write(brain, { 'hos/policy.yaml': 'version: 1\napprovals:\n  A4: { lane_t: auto }\n' });
  expect(validateBrain(brain, { root, home: brain }).ok).toBe(false);
  write(brain, { 'hos/policy.yaml': 'version: 1\napprovals:\n  preset: lenient\n' });
  expect(validateBrain(brain, { root, home: brain }).ok).toBe(false);
  write(brain, { 'hos/policy.yaml': 'version: 1\napprovals:\n  preset: balanced\n  plugin_edits: ask\n' });
  expect(validateBrain(brain, { root, home: brain }).ok).toBe(false);
  write(brain, { 'hos/policy.yaml': 'version: 1\nscript_classes:\n  deploy/: A9\n' });
  expect(validateBrain(brain, { root, home: brain }).ok).toBe(false);
});

test('hos brain update merges new starter commits, refuses a dirty brain and stops on a conflict without taking the starter’s side', async () => {
  const root = await hosRootWith(SKILLS, {});
  const starter = await starterRepo();
  const brain = join(await tempDir('hos-home-'), 'hos-brain');
  adoptBrain({ dir: brain, starter, name: 'Asha', root, home: brain });
  identity(brain);
  git(brain, 'add', '-A');
  git(brain, 'commit', '-q', '-m', 'Make this brain mine');

  write(starter, { 'AGENTS.md': '# rules\n- R1 new starter rule\n' });
  git(starter, 'commit', '-q', '-am', 'starter v2');
  const merged = brainUpdate(brain, { root, home: brain });
  expect(merged.ok).toBe(true);
  expect(merged.lines.join('\n')).toMatch(/new in starter\/starter:\n {2}[0-9a-f]+ starter v2/);
  expect(readFileSync(join(brain, 'AGENTS.md'), 'utf8')).toContain('R1 new starter rule');
  expect(readFileSync(join(brain, 'shared/USER.md'), 'utf8')).toContain('- Name: Asha');

  writeFileSync(join(brain, 'AGENTS.md'), '# rules\n- R1 my rule\n');
  expect(brainUpdate(brain, { root, home: brain }).lines[0]).toContain('uncommitted changes');
  git(brain, 'commit', '-q', '-am', 'my rule');
  write(starter, { 'AGENTS.md': '# rules\n- R1 newer starter rule\n' });
  git(starter, 'commit', '-q', '-am', 'starter v3');

  const conflicted = brainUpdate(brain, { root, home: brain });
  expect(conflicted.ok).toBe(false);
  expect(conflicted.lines).toContain('  AGENTS.md');
  expect(readFileSync(join(brain, 'AGENTS.md'), 'utf8')).toContain('<<<<<<<');
  expect(brainUpdate(brain, { root, home: brain }).lines[0]).toContain('a merge is already in progress');
});

test('a scratch daemon boots on an adopted starter brain with no plug-in: Home and Snags run on the local sources', async () => {
  const root = await hosRootWith(SKILLS, { handoff: ['lead'] });
  const brain = join(await tempDir('hos-home-'), 'hos-brain');
  expect(adoptBrain({ dir: brain, starter: await starterRepo(), name: 'Asha', timezone: 'Europe/Berlin', root, home: brain }).ok).toBe(true);
  git(brain, 'add', '-A');
  git(brain, 'commit', '-q', '-m', 'Make this brain mine');

  const hos = await startTestDaemon({ brainDir: brain });
  const snags = new SnagsClient(hos.client);
  await hos.client.capture('Read the release notes');
  await snags.add({ kind: 'question', text: 'Where do snags live?' });

  expect(await hos.client.sources()).toEqual({ tasks: { label: 'This computer' }, capture: { label: 'This computer' }, calendar: null, snags: { label: 'This computer' }, notifiers: [] });
  expect((await hos.client.myToday()).tasks.map((t) => t.title)).toEqual(['Read the release notes']);
  expect(await snags.summary()).toMatchObject({ open: 1, label: 'This computer' });
  expect((await hos.client.profiles()).map((p) => p.id)).toEqual(['generic', 'lead']);
  expect((await hos.client.doctorChecks()).filter((c) => c.id.startsWith('plugin') || c.id.startsWith('profile'))).toEqual([]);
});
