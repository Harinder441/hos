import { existsSync } from 'node:fs';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { HosClient } from '../src/api/client.js';
import { FakeAuthenticator } from '../src/fakes/fake-authenticator.js';
import type { HosEvent } from '../src/api/types.js';
import type { AgentScript } from '../src/fakes/scripted-agent-runtime.js';
import { cleanupAll, collect, enrolmentCode, opensEventStream, screen, startTestDaemon, tempDir, tempGitRepo } from './harness.js';
import { newTopic } from './topics.js';

afterEach(cleanupAll);

async function freshDaemon() {
  const hos = await startTestDaemon({ signedIn: false });
  const headers = hos.transportIdentity.headers();
  const passkey = new FakeAuthenticator(hos.transportIdentity.origin);
  const visitor = (authenticator?: FakeAuthenticator) =>
    new HosClient(hos.daemon.url, { headers, ...(authenticator ? { authenticator } : {}) });
  return { hos, headers, passkey, visitor, code: enrolmentCode(hos.dataDir) };
}

test('on the first visit nothing works until the user registers a passkey, which signs them in', async () => {
  const { hos, headers, passkey, visitor, code } = await freshDaemon();
  const repo = await tempGitRepo();
  const client = visitor(passkey);

  await expect(client.session()).resolves.toMatchObject({
    transport: 'tailscale',
    origin: 'https://hos-mac.tail0000.ts.net',
    registered: false,
    signedIn: false,
  });
  await expect(client.createProject(repo)).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/passkey/) });
  expect(await opensEventStream(client, hos.daemon.url, headers)).toBe(false);

  await client.registerPasskey(code);

  await expect(client.session()).resolves.toMatchObject({ registered: true, signedIn: true });
  await expect(client.createProject(repo)).resolves.toMatchObject({ path: repo });
  expect(await opensEventStream(client, hos.daemon.url, headers)).toBe(true);
  await expect(visitor().createProject(repo)).rejects.toMatchObject({ status: 401 });
});

test('a local process without the enrolment code the daemon wrote on the Mac cannot register the first passkey', async () => {
  const { hos, passkey, visitor } = await freshDaemon();
  const file = join(hos.dataDir, 'enrolment-code');
  const code = (await readFile(file, 'utf8')).trim();
  expect((await stat(file)).mode & 0o777).toBe(0o600);

  const agent = visitor(new FakeAuthenticator(passkey.origin));
  await expect(agent.registerPasskey()).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/setup code/) });
  await expect(agent.registerPasskey('wrong-guess')).rejects.toMatchObject({ status: 403 });
  await expect(visitor(passkey).registerPasskey(code)).resolves.toBeUndefined();

  expect(existsSync(file)).toBe(false);
  await expect(agent.listProjects()).rejects.toMatchObject({ status: 401 });
});

test('once a passkey exists nobody can register another; the same synced passkey signs in on the phone', async () => {
  const { passkey, visitor, code } = await freshDaemon();
  await visitor(passkey).registerPasskey(code);

  const intruder = visitor(new FakeAuthenticator(passkey.origin));
  await expect(intruder.registerPasskey()).rejects.toMatchObject({ status: 409 });
  await expect(intruder.signIn()).rejects.toThrow(/no passkey/);
  await expect(intruder.listProjects()).rejects.toMatchObject({ status: 401 });

  const phone = visitor(new FakeAuthenticator(passkey.origin, passkey.credentials));
  await phone.signIn();
  await expect(phone.listProjects()).resolves.toEqual(expect.any(Array));
});

test('a passkey assertion made on another origin, such as a dev-server preview port, is refused', async () => {
  const { passkey, visitor, code } = await freshDaemon();
  await visitor(passkey).registerPasskey(code);

  const preview = visitor(passkey.at(`${passkey.origin}:4123`));
  await expect(preview.signIn()).rejects.toMatchObject({ status: 401 });
  await expect(preview.listProjects()).rejects.toMatchObject({ status: 401 });
});

test('a signed-in session survives a daemon restart', async () => {
  const first = await startTestDaemon();
  const token = first.client.sessionToken;
  await first.stop();

  const second = await startTestDaemon({ dataDir: first.dataDir, signedIn: false });
  const client = new HosClient(second.daemon.url, { headers: second.transportIdentity.headers(), sessionToken: token! });
  await expect(client.session()).resolves.toMatchObject({ registered: true, signedIn: true });
  await expect(client.listProjects()).resolves.toEqual(expect.any(Array));
});

const writeScript: AgentScript = (input) => [
  { tool: 'Write', input: { file_path: input, content: 'hi' }, output: 'ok', ask: true, writes: { path: input, content: 'hi' } },
  { delta: 'Done.' },
];

test('the passkey is only for sign-in: a signed-in session approves, opens a terminal and runs destructive actions with no step-up', async () => {
  const hos = await startTestDaemon({ script: writeScript });
  const repo = await tempGitRepo();
  const project = await hos.client.createProject(repo);
  const workspace = await newTopic(hos.client, project.id, 'no-step-up');
  const dirty = await hos.client.createWorktree(project.id, { branch: 'dirty', baseRef: 'main' });
  await writeFile(join(dirty.path, 'scratch.txt'), 'wip\n');
  await writeFile(join(repo, 'README.md'), 'scribbled\n');
  const sessionOnly = new HosClient(hos.daemon.url, { headers: hos.transportIdentity.headers(), sessionToken: hos.client.sessionToken! });
  const stream = collect(hos.client);
  await sessionOnly.sendMessage((await sessionOnly.createChat(workspace.id)).id, 'a.txt');
  const events = await stream.until((es) => es.some((e) => e.type === 'approval.requested'));
  const asked = events.find((e): e is Extract<HosEvent, { type: 'approval.requested' }> => e.type === 'approval.requested')!;

  await sessionOnly.decideApproval(asked.approvalId, 'approve', { via: 'phone' });
  await stream.until((es) => es.some((e) => e.type === 'approval.resolved' && e.approvalId === asked.approvalId));
  const terminal = await sessionOnly.createTerminal({ worktreePath: repo });
  const opened = screen(sessionOnly, terminal.name);
  opened.write('echo hos-$((6*7))\r');
  await opened.until(/hos-42/);
  await expect(sessionOnly.discardFile(workspace.folder.id, 'README.md')).resolves.toMatchObject({ action: 'discard' });
  await expect(sessionOnly.removeWorktree(dirty.path, { force: true })).resolves.toMatchObject({ removed: dirty.path });
  await expect(sessionOnly.archiveTopic(workspace.id)).resolves.toMatchObject({ state: 'archived' });
  expect(existsSync(dirty.path)).toBe(false);
});

test('the data folder is readable only by its owner, so other accounts on the computer cannot read transcripts', async () => {
  const dataDir = await tempDir();
  await chmod(dataDir, 0o755);
  const hos = await startTestDaemon({ signedIn: false, dataDir });
  expect((await stat(hos.dataDir)).mode & 0o777).toBe(0o700);
});

test('a malformed path before sign-in gets a 400 and the daemon keeps answering', async () => {
  const webRoot = await tempDir();
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>hos</title>');
  const hos = await startTestDaemon({ signedIn: false, webRoot });
  expect((await fetch(`${hos.daemon.url}/%E0%A4`)).status).toBe(400);
  expect((await fetch(`${hos.daemon.url}/`)).status).toBe(200);
});
