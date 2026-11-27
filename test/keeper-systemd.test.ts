import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { keeperCommand, type CommandRunner } from '../src/launchd.js';
import { cleanupAll, tempDir } from './harness.js';

afterEach(cleanupAll);

function fakeHost(answers: Record<string, string | Error> = {}) {
  const calls: string[] = [];
  const run: CommandRunner = async (bin, args) => {
    const line = [bin, ...args].join(' ');
    calls.push(line);
    const answer = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1] ?? '';
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  return { host: { platform: 'linux' as const, run }, calls };
}

test('on Linux hos keeper install writes a systemd user unit that starts hos at boot and after a crash, then enables and restarts it', async () => {
  const unitDir = await tempDir('hos-systemd-');
  const logs = await tempDir('hos-logs-');
  const keeperFlags = ['--systemd-dir', unitDir, '--systemctl-bin', '/fake/systemctl', '--loginctl-bin', '/fake/loginctl', '--logs-dir', logs];
  const daemonFlags = ['--brain', '/srv/brain', '--cells', 'off', '--work-suffix', 'pc', '--healthchecks-url', 'https://hc-ping.test.invalid/a b%'];
  const { host, calls } = fakeHost({ '/fake/loginctl': 'no\n' });
  const unit = join(unitDir, 'hos.service');

  const installed = await keeperCommand('install', [...keeperFlags, ...daemonFlags], host);

  const path = [...new Set([dirname(process.execPath), ...(process.env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(':');
  const program = [process.execPath, ...process.execArgv, resolve(process.argv[1]!)].join(' ');
  expect(readFileSync(unit, 'utf8')).toBe(`[Unit]
Description=hos agent daemon

[Service]
Type=simple
WorkingDirectory=${process.cwd()}
ExecStart=${program} --brain /srv/brain --cells off --work-suffix pc --healthchecks-url "https://hc-ping.test.invalid/a b%%"
Environment=${/^[\w@%+=:,./-]+$/.test(`PATH=${path}`) ? `PATH=${path}` : `"PATH=${path}"`}
Restart=always
RestartSec=5
KillMode=process
StandardOutput=append:${logs}/hos.log
StandardError=append:${logs}/hos.log

[Install]
WantedBy=default.target
`);
  expect(calls).toEqual([
    '/fake/systemctl --user daemon-reload',
    '/fake/systemctl --user enable hos.service',
    '/fake/systemctl --user restart hos.service',
    `/fake/loginctl show-user ${userInfo().username} -p Linger --value`,
  ]);
  expect(installed).toContain(`installed ${unit}`);
  expect(installed).toContain(`sudo loginctl enable-linger ${userInfo().username}`);

  expect(await keeperCommand('install', keeperFlags, fakeHost({ '/fake/loginctl': 'yes\n' }).host)).not.toContain('enable-linger');
  expect(await keeperCommand('install', keeperFlags, fakeHost({ '/fake/loginctl': new Error('no loginctl') }).host)).not.toContain('enable-linger');
});

test('on Linux restart, status and uninstall go through systemctl --user', async () => {
  const unitDir = await tempDir('hos-systemd-');
  const flags = ['--systemd-dir', unitDir, '--systemctl-bin', '/fake/systemctl', '--logs-dir', await tempDir('hos-logs-')];
  const inactive = Object.assign(new Error('exit 3'), { stdout: 'inactive\n' });
  const { host, calls } = fakeHost({ '/fake/systemctl --user is-active': inactive, '/fake/loginctl': 'yes' });

  await keeperCommand('install', [...flags, '--loginctl-bin', '/fake/loginctl'], host);
  expect(await keeperCommand('restart', flags, host)).toBe('restarted hos under systemd');
  expect(await keeperCommand('status', flags, host)).toBe('hos.service is inactive');
  expect(await keeperCommand('uninstall', flags, host)).toContain('no longer starts at boot');
  expect(existsSync(join(unitDir, 'hos.service'))).toBe(false);
  expect(calls.slice(-4)).toEqual([
    '/fake/systemctl --user restart hos.service',
    '/fake/systemctl --user is-active hos.service',
    '/fake/systemctl --user disable --now hos.service',
    '/fake/systemctl --user daemon-reload',
  ]);
  await expect(keeperCommand('reload', flags, host)).rejects.toThrow('usage: hos keeper install|uninstall|restart|status');
});
