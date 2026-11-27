import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const DEFAULT_LABEL = 'dev.hos.daemon';
const SERVICE = 'hos.service';

const run = promisify(execFile);
const KEEPER_FLAGS = new Set(['--launch-agents-dir', '--launchctl-bin', '--logs-dir', '--launchd-label']);
const SHARED_FLAGS = new Set(['--launchd-label']);
const SYSTEMD_FLAGS = new Set(['--systemd-dir', '--systemctl-bin', '--loginctl-bin', '--logs-dir']);

export function launchAgentPlist(dir = join(homedir(), 'Library', 'LaunchAgents'), label = DEFAULT_LABEL): string {
  return join(dir, `${label}.plist`);
}

export interface AgentSpec {
  label?: string;
  programArguments: string[];
  workingDirectory: string;
  path: string;
  logsDir: string;
}

export function plistXml(spec: AgentSpec): string {
  const string = (value: string) => `<string>${escape(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(spec.label ?? DEFAULT_LABEL)}
  <key>ProgramArguments</key>
  <array>
${spec.programArguments.map((arg) => `    ${string(arg)}`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  ${string(spec.workingDirectory)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${string(spec.path)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  ${string('Interactive')}
  <key>StandardOutPath</key>
  ${string(join(spec.logsDir, 'hos.out.log'))}
  <key>StandardErrorPath</key>
  ${string(join(spec.logsDir, 'hos.err.log'))}
</dict>
</plist>
`;
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface UnitSpec {
  execStart: string[];
  workingDirectory: string;
  path: string;
  logFile: string;
}

export function systemdUnit(spec: UnitSpec): string {
  return `[Unit]
Description=hos agent daemon

[Service]
Type=simple
WorkingDirectory=${systemdEscape(spec.workingDirectory)}
ExecStart=${spec.execStart.map(systemdQuote).join(' ')}
Environment=${systemdQuote(`PATH=${spec.path}`)}
Restart=always
RestartSec=5
KillMode=process
StandardOutput=append:${systemdEscape(spec.logFile)}
StandardError=append:${systemdEscape(spec.logFile)}

[Install]
WantedBy=default.target
`;
}

function systemdEscape(text: string): string {
  return text.replace(/%/g, '%%');
}

function systemdQuote(arg: string): string {
  const escaped = systemdEscape(arg).replace(/\$/g, '$$$$');
  return /^[\w@%+=:,./-]+$/.test(escaped) ? escaped : `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function splitArgs(args: string[], flags = KEEPER_FLAGS): { keeper: Map<string, string>; daemon: string[] } {
  const keeper = new Map<string, string>();
  const daemon: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (!flags.has(flag)) {
      daemon.push(args[i]!);
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    keeper.set(flag, value);
    if (SHARED_FLAGS.has(flag)) daemon.push(flag, value);
  }
  return { keeper, daemon };
}

export type CommandRunner = (bin: string, args: string[]) => Promise<{ stdout: string }>;

export interface KeeperHost {
  platform: NodeJS.Platform;
  run: CommandRunner;
}

const thisHost: KeeperHost = { platform: process.platform, run: (bin, args) => run(bin, args, { timeout: 30_000 }) };

export async function keeperCommand(sub: string | undefined, args: string[], host: KeeperHost = thisHost): Promise<string> {
  if (host.platform === 'linux') return systemdKeeper(sub, args, host.run);
  const { keeper, daemon } = splitArgs(args);
  const label = keeper.get('--launchd-label') ?? DEFAULT_LABEL;
  const plist = launchAgentPlist(keeper.get('--launch-agents-dir'), label);
  const launchctl = keeper.get('--launchctl-bin') ?? '/bin/launchctl';
  const domain = `gui/${process.getuid!()}`;
  const call = (...callArgs: string[]) => run(launchctl, callArgs, { timeout: 30_000 });
  if (sub === 'install') {
    const logsDir = keeper.get('--logs-dir') ?? join(homedir(), 'Library', 'Logs', 'hos');
    await mkdir(logsDir, { recursive: true });
    await mkdir(resolve(plist, '..'), { recursive: true });
    const spec: AgentSpec = {
      label,
      programArguments: [process.execPath, ...process.execArgv, resolve(process.argv[1]!), ...daemon],
      workingDirectory: process.cwd(),
      path: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      logsDir,
    };
    await writeFile(plist, plistXml(spec));
    await call('bootout', `${domain}/${label}`).catch(() => {});
    await call('bootstrap', domain, plist);
    return `installed ${plist}; launchd starts hos now, at every login and after a crash. Logs: ${logsDir}`;
  }
  if (sub === 'uninstall') {
    await call('bootout', `${domain}/${label}`).catch(() => {});
    await rm(plist, { force: true });
    return `uninstalled ${plist}; hos no longer starts at login`;
  }
  if (sub === 'restart') {
    await call('kickstart', '-k', `${domain}/${label}`);
    return 'restarted hos under launchd';
  }
  throw new Error('usage: hos keeper install|uninstall|restart [--launch-agents-dir <dir>] [--launchctl-bin <path>] [--logs-dir <dir>] [--launchd-label <label>] [daemon flags…]');
}

async function systemdKeeper(sub: string | undefined, args: string[], runner: CommandRunner): Promise<string> {
  const { keeper, daemon } = splitArgs(args, SYSTEMD_FLAGS);
  const unit = join(keeper.get('--systemd-dir') ?? join(homedir(), '.config', 'systemd', 'user'), SERVICE);
  const systemctl = (...callArgs: string[]) => runner(keeper.get('--systemctl-bin') ?? 'systemctl', ['--user', ...callArgs]);
  if (sub === 'install') {
    const logsDir = keeper.get('--logs-dir') ?? join(homedir(), '.local', 'state', 'hos');
    const logFile = join(logsDir, 'hos.log');
    await mkdir(logsDir, { recursive: true });
    await mkdir(dirname(unit), { recursive: true });
    const bins = [dirname(process.execPath), ...(process.env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin'];
    const spec: UnitSpec = {
      execStart: [process.execPath, ...process.execArgv, resolve(process.argv[1]!), ...daemon],
      workingDirectory: process.cwd(),
      path: [...new Set(bins.filter(Boolean))].join(':'),
      logFile,
    };
    await writeFile(unit, systemdUnit(spec));
    await systemctl('daemon-reload');
    await systemctl('enable', SERVICE);
    await systemctl('restart', SERVICE);
    const linger = await runner(keeper.get('--loginctl-bin') ?? 'loginctl', ['show-user', userInfo().username, '-p', 'Linger', '--value']).then(
      ({ stdout }) => stdout.trim(),
      () => '',
    );
    const hint = linger === 'no' ? `\nlinger is off, so hos stops when you log out and waits for a login after boot: sudo loginctl enable-linger ${userInfo().username}` : '';
    return `installed ${unit}; systemd starts hos now, at boot and after a crash. Logs: ${logFile}${hint}`;
  }
  if (sub === 'uninstall') {
    await systemctl('disable', '--now', SERVICE).catch(() => {});
    await rm(unit, { force: true });
    await systemctl('daemon-reload').catch(() => {});
    return `uninstalled ${unit}; hos no longer starts at boot`;
  }
  if (sub === 'restart') {
    await systemctl('restart', SERVICE);
    return 'restarted hos under systemd';
  }
  if (sub === 'status') {
    const state = await systemctl('is-active', SERVICE).then(
      ({ stdout }) => stdout.trim(),
      (error: { stdout?: string }) => error.stdout?.trim() || 'unknown',
    );
    return `${SERVICE} is ${state}`;
  }
  throw new Error('usage: hos keeper install|uninstall|restart|status [--systemd-dir <dir>] [--systemctl-bin <path>] [--loginctl-bin <path>] [--logs-dir <dir>] [daemon flags…]');
}
