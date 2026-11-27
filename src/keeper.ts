import { statfs } from 'node:fs/promises';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { Clock } from './adapters/clock.js';
import type { Machine } from './adapters/machine.js';
import type { DoctorReport, MachineReading, StatusItem, WindowReadings } from './api/types.js';
import { commitIdentityRow } from './commit-identity.js';
import { CRITICAL_BATTERY_PCT, LOW_BATTERY_PCT } from './governor.js';
import type { BackupLabel, Store } from './store.js';
import type { Tmux } from './tmux.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PING_TIMEOUT_MS = 10_000;
const LOW_DISK_BYTES = 10 * 1024 ** 3;
const PRUNE_BATCH = 10_000;

type RestartKind = 'first' | 'reboot' | 'crash' | 'restart';
type BatteryLevel = 'ok' | 'low' | 'critical';

const RESTART_TITLES: Record<Exclude<RestartKind, 'first'>, string> = {
  reboot: 'Mac restarted',
  crash: 'hos restarted after a crash',
  restart: 'hos restarted',
};
export const BATTERY_ALERTS = ['Battery low', 'Battery critical'];
export const INFO_ALERTS = [...Object.values(RESTART_TITLES), 'Power back'];
export const INFO_ALERT_MS = 30 * MINUTE;

export interface KeeperDeps {
  store: Store;
  clock: Clock;
  machine: Machine;
  tmux: Tmux;
  dataDir: string;
  healthchecksUrl?: string;
  brainDir?: string;
  repoDirs?: () => string[];
  retentionDays?: () => number;
  alert(title: string, detail: string): void;
  pauseRunning(): Promise<string[]>;
  resume(chatId: string, text: string): Promise<void>;
}

export class Keeper {
  private readonly startedAt: number;
  private restart: RestartKind = 'first';
  private release: (() => void) | null = null;
  private battery: BatteryLevel = 'ok';
  private lastPing: { at: number; ok: boolean } | null = null;

  constructor(private readonly deps: KeeperDeps) {
    this.startedAt = deps.clock.now();
  }

  async boot(): Promise<void> {
    const { store, machine } = this.deps;
    this.release ??= machine.keepAwake();
    const booted = await machine.bootedAt().catch(() => null);
    const previousBoot = store.meta('booted_at');
    const firstRun = store.meta('started_at') === undefined;
    store.setMeta('started_at', String(this.startedAt));
    if (booted !== null) store.setMeta('booted_at', String(booted));
    this.restart = firstRun
      ? 'first'
      : booted !== null && previousBoot !== undefined && String(booted) !== previousBoot
        ? 'reboot'
        : store.crashed
          ? 'crash'
          : 'restart';
    if (this.restart === 'first') return;
    const title = RESTART_TITLES[this.restart];
    const chats = await this.resumeInterrupted(`[hos] ${title} while you were working. Carry on where you left off.`);
    if (this.restart === 'restart' && !chats) return;
    this.deps.alert(title, `hos is back: resumed ${plural(chats, 'chat')} that ${chats === 1 ? 'was' : 'were'} mid-turn.`);
  }

  async tick(reading: MachineReading | null): Promise<void> {
    void this.ping();
    await this.keepBattery(reading);
    const last = this.deps.store.backups()[0]?.at ?? this.startedAt;
    if (this.deps.clock.now() - last >= DAY && this.backup('daily')) {
      await this.pruneDeltas();
      this.pruneArchived();
    }
  }

  stop(): void {
    this.release?.();
    this.release = null;
  }

  async health(transport: DoctorReport, reading: MachineReading | null, windows: WindowReadings): Promise<StatusItem[]> {
    const { store, tmux, dataDir } = this.deps;
    const sessions = await tmux.list().then(
      (list) => ({ ok: true, count: list.length }),
      () => ({ ok: false, count: 0 }),
    );
    const disk = await statfs(dataDir).catch(() => null);
    const free = disk ? disk.bavail * disk.bsize : null;
    const backups = store.backups();
    const [latest] = backups;
    const battery = reading?.battery;
    return [
      item('daemon', 'Daemon', 'ok', `up since ${iso(this.startedAt)}, pid ${process.pid}, ${RESTART_DETAIL[this.restart]}`),
      item('tmux', 'tmux', sessions.ok ? 'ok' : 'down', sessions.ok ? `${plural(sessions.count, 'session')}` : 'the tmux server did not answer'),
      item('transport', `Remote access (${transport.transport})`, transport.ok ? 'ok' : 'down', transport.message),
      item(
        'disk',
        'Disk',
        free === null ? 'down' : free < LOW_DISK_BYTES ? 'warn' : 'ok',
        free === null ? 'could not read free space' : `${gigabytes(free)} free of ${gigabytes(disk!.blocks * disk!.bsize)}`,
      ),
      item(
        'battery',
        'Battery',
        !battery ? 'off' : this.battery === 'critical' ? 'down' : this.battery === 'low' ? 'warn' : 'ok',
        !battery ? 'no battery reading' : `${battery.percent}%${battery.onBattery ? ' on battery' : ' on the charger'}`,
      ),
      item('thermal', 'Thermal', !reading ? 'off' : reading.thermalWarning ? 'warn' : 'ok', !reading ? 'no reading yet' : reading.thermalWarning ? 'thermal warning' : 'no thermal warning'),
      item('memory', 'Memory', !reading ? 'off' : reading.memory === 'normal' ? 'ok' : reading.memory === 'warn' ? 'warn' : 'down', reading ? `pressure ${reading.memory}` : 'no reading yet'),
      item('windows', 'Provider windows', windowStatus(windows), `Claude 5-hour ${windowText(windows.fiveHour)} · weekly ${windowText(windows.weekly)}`),
      item(
        'awake',
        'Sleep',
        this.release ? 'ok' : 'warn',
        this.release ? `idle sleep prevented (${this.deps.machine.keeper === 'systemd' ? 'systemd-inhibit' : 'caffeinate -i'})` : 'idle sleep allowed (critical battery)',
      ),
      item(
        'watchdog',
        'Watchdog',
        !this.deps.healthchecksUrl ? 'off' : !this.lastPing ? 'warn' : this.lastPing.ok ? 'ok' : 'down',
        !this.deps.healthchecksUrl
          ? 'no healthchecks.io ping URL'
          : !this.lastPing
            ? 'no ping sent yet'
            : `last ping ${this.lastPing.ok ? 'answered' : 'failed'} at ${iso(this.lastPing.at)}`,
      ),
      item('backups', 'Backups', latest ? 'ok' : 'warn', latest ? `latest ${iso(latest.at)} (${latest.label}), ${backups.length} kept` : 'no backup yet'),
    ];
  }

  async doctor(transport: DoctorReport): Promise<StatusItem[]> {
    const facts = await this.deps.machine.setup();
    const login = (name: string, login: typeof facts.claude, fix: string) =>
      !login ? item(name.toLowerCase(), `${name} login`, 'down', `the ${name.toLowerCase()} CLI was not found`, `install the ${name} CLI`)
      : login.loggedIn ? item(name.toLowerCase(), `${name} login`, 'ok', `logged in${login.plan ? ` (${login.plan} plan)` : ''}`)
      : item(name.toLowerCase(), `${name} login`, 'down', 'not logged in', fix);
    const systemd = this.deps.machine.keeper === 'systemd';
    return [
      item('transport', `Remote access (${transport.transport})`, transport.ok ? 'ok' : 'down', transport.message, transport.ok ? undefined : transport.fix.join('; ')),
      systemd
        ? item(
            'keeper',
            'Background service (systemd)',
            facts.launchAgent ? 'ok' : 'down',
            facts.launchAgent ? 'hos.service is active under systemd --user' : 'hos.service is not active, so hos does not start at boot or restart on a crash',
            facts.launchAgent ? undefined : 'hos keeper install',
          )
        : item(
            'keeper',
            'Background service (launchd)',
            facts.launchAgent ? 'ok' : 'down',
            facts.launchAgent ? 'the LaunchAgent is installed' : 'hos does not start at login or restart on a crash',
            facts.launchAgent ? undefined : 'hos keeper install',
          ),
      item(
        'watchdog',
        'Watchdog',
        this.deps.healthchecksUrl ? 'ok' : 'down',
        this.deps.healthchecksUrl ? 'pings healthchecks.io every minute' : 'nothing outside the Mac notices when it goes down',
        this.deps.healthchecksUrl
          ? undefined
          : 'create a healthchecks.io check (period 1 min, grace 5 min) that alerts you, then hos keeper install --healthchecks-url <ping URL>',
      ),
      ...(systemd
        ? []
        : [
            item(
              'charge_limit',
              'Charge limit',
              facts.chargeLimit === 'set' ? 'ok' : facts.chargeLimit === 'unset' ? 'down' : 'warn',
              facts.chargeLimit === 'set' ? 'a charge limit is set' : facts.chargeLimit === 'unset' ? 'no charge limit' : 'could not read the charge limit',
              facts.chargeLimit === 'set' ? undefined : 'System Settings → Battery → Charging → Charge Limit 80%',
            ),
          ]),
      login('Claude', facts.claude, 'claude auth login'),
      await commitIdentityRow(this.deps.brainDir, this.deps.repoDirs?.() ?? []),
    ];
  }

  private async keepBattery(reading: MachineReading | null): Promise<void> {
    const battery = reading?.battery;
    const level: BatteryLevel = !battery?.onBattery
      ? 'ok'
      : battery.percent <= CRITICAL_BATTERY_PCT
        ? 'critical'
        : battery.percent <= LOW_BATTERY_PCT
          ? 'low'
          : 'ok';
    const previous = this.battery;
    if (level === previous) return;
    this.battery = level;
    if (level === 'low' && previous === 'ok') {
      this.backup('battery');
      this.deps.alert(
        'Battery low',
        `The Mac is on battery at ${battery!.percent}%. hos saved a checkpoint of its store; only P0-P1 work starts until the charger is back.`,
      );
    }
    if (level === 'critical') {
      const paused = await this.deps.pauseRunning();
      for (const chatId of paused) this.deps.store.setChatInterrupted(chatId, true);
      this.backup('battery');
      this.stop();
      this.deps.alert(
        'Battery critical',
        `The Mac is on battery at ${battery!.percent}%. hos paused ${plural(paused.length, 'running chat')} and lets the Mac sleep; they resume when the charger is back.`,
      );
    }
    if (level === 'ok') {
      this.release ??= this.deps.machine.keepAwake();
      const resumed = await this.resumeInterrupted('[hos] The Mac is back on the charger. Carry on where you left off.');
      if (previous === 'critical') this.deps.alert('Power back', `The Mac is on the charger again; hos resumed ${plural(resumed, 'chat')}.`);
    }
  }

  private async resumeInterrupted(text: string): Promise<number> {
    let resumed = 0;
    for (const chat of this.deps.store.interruptedChats()) {
      this.deps.store.setChatInterrupted(chat.id, false);
      if (chat.state !== 'idle' && chat.state !== 'paused') continue;
      try {
        await this.deps.resume(chat.id, text);
        resumed += 1;
      } catch (error) {
        console.error(`resuming chat ${chat.id} failed`, error);
      }
    }
    return resumed;
  }

  private backup(label: BackupLabel): boolean {
    try {
      this.deps.store.backup(label, this.deps.clock.now());
      return true;
    } catch (error) {
      console.error('backup failed', error);
      return false;
    }
  }

  private async pruneDeltas(): Promise<void> {
    try {
      const seqs = this.deps.store.supersededDeltas(0);
      let pruned = 0;
      for (let i = 0; i < seqs.length; i += PRUNE_BATCH) {
        pruned += this.deps.store.deleteDeltas(seqs.slice(i, i + PRUNE_BATCH));
        await yieldLoop();
      }
      if (pruned) console.log(`keeper: pruned ${pruned} superseded delta events after the daily backup`);
    } catch (error) {
      console.error('pruning deltas failed', error);
    }
  }

  private pruneArchived(): void {
    try {
      const days = this.deps.retentionDays?.() ?? 0;
      if (!days) return;
      const pruned = this.deps.store.pruneArchivedDetail(this.deps.clock.now() - days * DAY);
      if (pruned) console.log(`keeper: pruned ${pruned} thinking, progress and approval events of topics archived over ${days} days ago`);
    } catch (error) {
      console.error('pruning archived topics failed', error);
    }
  }

  private async ping(): Promise<void> {
    const url = this.deps.healthchecksUrl;
    if (!url) return;
    const ok = await fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) }).then(
      (res) => res.ok,
      () => false,
    );
    this.lastPing = { at: this.deps.clock.now(), ok };
  }
}

const RESTART_DETAIL: Record<RestartKind, string> = {
  first: 'first start on this data directory',
  reboot: 'started after a Mac restart',
  crash: 'restarted after a crash',
  restart: 'restarted cleanly',
};

function item(id: string, label: string, status: StatusItem['status'], detail: string, fix?: string): StatusItem {
  return { id, label, status, detail, ...(fix ? { fix } : {}) };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function windowText(window: WindowReadings['fiveHour']): string {
  return window ? `${Math.round(window.pct)}%` : 'no reading';
}

function windowStatus(windows: WindowReadings): StatusItem['status'] {
  const pct = Math.max(windows.fiveHour?.pct ?? 0, windows.weekly?.pct ?? 0);
  return pct >= 95 ? 'down' : pct >= 70 ? 'warn' : 'ok';
}
