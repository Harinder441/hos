import type { Clock } from './adapters/clock.js';
import type { GovernorStatus, HomeAlert, HomeSummary, InboxItem, ProviderWindow } from './api/types.js';
import { CRITICAL_BATTERY_PCT } from './governor.js';
import { ownerSettings } from './owner.js';
import type { Store } from './store.js';

export const USAGE_ALERT_PCT = 85;
export const BATTERY_ALERT_PCT = 20;
const USAGE_STEPS = [USAGE_ALERT_PCT, 95];
const META_KEY = 'home.alerts';

interface Saved {
  since: Record<string, number>;
  dismissed: string[];
}

export class HomeAlerts {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  summary(governor: GovernorStatus, inbox: InboxItem[]): HomeSummary {
    const { fiveHour, weekly } = governor.windows;
    const keeper: HomeAlert[] = inbox
      .filter((item) => item.kind === 'keeper' && item.state === 'open')
      .map((item) => ({ id: item.id, kind: 'keeper', text: item.title, at: item.createdAt }));
    const live: Array<Omit<HomeAlert, 'at'>> = [];
    const battery = governor.machine?.battery;
    if (battery?.onBattery && battery.percent < BATTERY_ALERT_PCT) {
      const level = battery.percent <= CRITICAL_BATTERY_PCT ? 'critical' : 'low';
      live.push({ id: `battery:${level}`, kind: 'battery', text: `Battery at ${Math.round(battery.percent)}%, unplugged` });
    }
    const usage = (key: string, name: string, window: ProviderWindow | null, weekday: boolean) => {
      if (!window || window.pct < USAGE_ALERT_PCT) return;
      const step = USAGE_STEPS.filter((pct) => window.pct >= pct).at(-1);
      const resets = window.resetsAt === null ? '' : `, resets ${weekday ? `${day(window.resetsAt)} at` : 'at'} ${time(window.resetsAt)}`;
      live.push({ id: `usage:${key}:${window.resetsAt ?? 'open'}:${step}`, kind: 'usage', text: `Claude ${name} window at ${Math.round(window.pct)}%${resets}` });
    };
    usage('five-hour', '5-hour', fiveHour, false);
    usage('weekly', 'weekly', weekly, true);
    const saved = this.saved();
    const now = this.clock.now();
    const next: Saved = {
      since: Object.fromEntries(live.map((alert) => [alert.id, saved.since[alert.id] ?? now])),
      dismissed: saved.dismissed.filter((id) => live.some((alert) => alert.id === id)),
    };
    if (JSON.stringify(next) !== JSON.stringify(saved)) this.save(next);
    return {
      usage: {
        fiveHour: fiveHour ? Math.round(fiveHour.pct) : null,
        weekly: weekly ? Math.round(weekly.pct) : null,
        resetsAt: fiveHour?.resetsAt ?? null,
      },
      alerts: [
        ...keeper,
        ...live.filter((alert) => !next.dismissed.includes(alert.id)).map((alert) => ({ ...alert, at: next.since[alert.id]! })),
      ],
    };
  }

  dismiss(id: string): void {
    const saved = this.saved();
    if (!saved.dismissed.includes(id)) this.save({ ...saved, dismissed: [...saved.dismissed, id] });
  }

  private saved(): Saved {
    const raw = this.store.meta(META_KEY);
    return raw ? (JSON.parse(raw) as Saved) : { since: {}, dismissed: [] };
  }

  private save(saved: Saved): void {
    this.store.setMeta(META_KEY, JSON.stringify(saved));
  }
}

function time(at: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ownerSettings().timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

function day(at: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ownerSettings().timezone, weekday: 'short' }).format(at);
}
