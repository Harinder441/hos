import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { MachineReading, MachineSetup, SubscriptionLogin } from '../api/types.js';
import { bundledClaude, claudeEnv } from './claude-bin.js';

export type MachineSample = MachineReading;
export type { MachineSetup };

export interface Machine {
  readonly keeper?: 'launchd' | 'systemd';
  sample(): Promise<MachineSample>;
  bootedAt(): Promise<number | null>;
  keepAwake(): () => void;
  setup(): Promise<MachineSetup>;
}

export const steadyMachine: Machine = {
  sample: async () => ({ memory: 'normal', thermalWarning: false, battery: null }),
  bootedAt: async () => null,
  keepAwake: () => () => {},
  setup: async () => ({ chargeLimit: 'unknown', claude: null, launchAgent: false, browser: true }),
};

const run = promisify(execFile);

async function output(command: string, args: string[], timeout = 5_000): Promise<string> {
  return (await run(command, args, { timeout })).stdout;
}

export function parseMemoryLevel(level: string): MachineSample['memory'] {
  const value = Number(level.trim());
  return value >= 4 ? 'critical' : value >= 2 ? 'warn' : 'normal';
}

export function parseTherm(text: string): boolean {
  return /warning level\s*[:=]?\s*[1-9]/i.test(text);
}

export function parseBattery(text: string): MachineSample['battery'] {
  const percent = /(\d+)%/.exec(text)?.[1];
  if (percent === undefined) return null;
  return { percent: Number(percent), onBattery: /'Battery Power'/.test(text) };
}

export function parseBootTime(text: string): number | null {
  const sec = /sec = (\d+)/.exec(text)?.[1];
  return sec ? Number(sec) * 1000 : null;
}

export const PSI_WARN = 10;
export const PSI_CRITICAL = 30;

export function parsePressure(text: string): MachineSample['memory'] {
  const avg10 = Number(/^some\b.*\bavg10=([\d.]+)/m.exec(text)?.[1] ?? 0);
  return avg10 >= PSI_CRITICAL ? 'critical' : avg10 >= PSI_WARN ? 'warn' : 'normal';
}

export function parseProcBootTime(text: string): number | null {
  const sec = /^btime (\d+)/m.exec(text)?.[1];
  return sec ? Number(sec) * 1000 : null;
}

const CHARGING_POLICIES =
  'defaults export /Library/Preferences/com.apple.powerd.charging - | plutil -extract policies raw -o - - | base64 -d | plutil -p -';

export interface MacMachineOptions {
  claudeBin?: string;
  launchAgentPlist: string;
}

export class MacMachine implements Machine {
  constructor(private readonly options: MacMachineOptions) {}

  async sample(): Promise<MachineSample> {
    const [level, therm, batt] = await Promise.all([
      output('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).catch(() => '1'),
      output('pmset', ['-g', 'therm']).catch(() => ''),
      output('pmset', ['-g', 'batt']).catch(() => ''),
    ]);
    return { memory: parseMemoryLevel(level), thermalWarning: parseTherm(therm), battery: parseBattery(batt) };
  }

  async bootedAt(): Promise<number | null> {
    return parseBootTime(await output('sysctl', ['-n', 'kern.boottime']).catch(() => ''));
  }

  keepAwake(): () => void {
    const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    child.on('error', (error) => console.error('caffeinate failed', error));
    return () => void child.kill();
  }

  async setup(): Promise<MachineSetup> {
    const [chargeLimit, claude] = await Promise.all([this.chargeLimit(), this.claudeLogin()]);
    return {
      chargeLimit,
      claude,
      launchAgent: existsSync(this.options.launchAgentPlist),
      browser: existsSync('/Applications/Google Chrome.app'),
    };
  }

  private async chargeLimit(): Promise<MachineSetup['chargeLimit']> {
    const text = await output('sh', ['-c', CHARGING_POLICIES]).catch(() => '');
    if (!text.includes('NS.objects')) return 'unknown';
    return /"NS\.objects" => \[\s*\]/.test(text) ? 'unset' : 'set';
  }

  private claudeLogin(): Promise<SubscriptionLogin | null> {
    return claudeLogin(this.options.claudeBin);
  }
}

export interface LinuxMachineOptions {
  claudeBin?: string;
  readFile?: (path: string) => Promise<string>;
  run?: (command: string, args: string[]) => Promise<string>;
  spawnInhibitor?: () => ChildProcess;
}

export class LinuxMachine implements Machine {
  readonly keeper = 'systemd' as const;
  private readonly read: (path: string) => Promise<string>;
  private readonly run: (command: string, args: string[]) => Promise<string>;

  constructor(private readonly options: LinuxMachineOptions = {}) {
    this.read = options.readFile ?? ((path) => readFile(path, 'utf8'));
    this.run = options.run ?? ((command, args) => output(command, args));
  }

  async sample(): Promise<MachineSample> {
    const pressure = await this.read('/proc/pressure/memory').catch(() => '');
    return { memory: parsePressure(pressure), thermalWarning: false, battery: null };
  }

  async bootedAt(): Promise<number | null> {
    return parseProcBootTime(await this.read('/proc/stat').catch(() => ''));
  }

  keepAwake(): () => void {
    const child =
      this.options.spawnInhibitor?.() ??
      spawn('systemd-inhibit', ['--what=idle:sleep', '--who=hos', '--why=hos keeps chats running', 'sleep', 'infinity'], { stdio: 'ignore' });
    child.on('error', (error) => console.error('systemd-inhibit failed', error));
    return () => void child.kill();
  }

  async setup(): Promise<MachineSetup> {
    const [active, claude] = await Promise.all([
      this.run('systemctl', ['--user', 'is-active', 'hos.service']).catch((error: { stdout?: string }) => error.stdout ?? ''),
      claudeLogin(this.options.claudeBin),
    ]);
    const browser = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'].some((path) => existsSync(path));
    return { chargeLimit: 'unknown', claude, launchAgent: active.trim() === 'active', browser };
  }
}

async function claudeLogin(bin = bundledClaude()): Promise<SubscriptionLogin | null> {
  const text = await run(bin, ['auth', 'status'], { timeout: 10_000, env: claudeEnv() }).then(({ stdout }) => stdout).catch((error: { stdout?: string; code?: string }) =>
    error.code === 'ENOENT' ? null : (error.stdout ?? ''),
  );
  if (text === null) return null;
  try {
    const status = JSON.parse(text) as { loggedIn?: boolean; subscriptionType?: string };
    return { loggedIn: status.loggedIn === true, plan: status.subscriptionType ?? null };
  } catch {
    return { loggedIn: false, plan: null };
  }
}
