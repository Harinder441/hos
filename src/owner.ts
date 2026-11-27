import type { OwnerInfo } from './api/types.js';

export interface OwnerSettings {
  name: string | null;
  timezone: string;
  timezoneLabel: string | null;
  words: string[];
  mishears: Record<string, string>;
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function defaultOwnerSettings(): OwnerSettings {
  return { name: null, timezone: systemTimezone(), timezoneLabel: null, words: [], mishears: {} };
}

// One owner per daemon process; module-level so prompt and tool texts read it without threading it through every call.
let current: OwnerSettings = defaultOwnerSettings();

export function setOwnerSettings(settings: OwnerSettings): void {
  current = settings;
}

export function ownerSettings(): OwnerSettings {
  return current;
}

export function owner(): string {
  return current.name ?? 'the user';
}

export function ownerStart(): string {
  return current.name ?? 'The user';
}

export function ownerInfo(at = Date.now()): OwnerInfo {
  return { name: current.name, timezone: current.timezone, timezoneLabel: zoneLabel(at) };
}

export function localDate(at: number, timeZone = current.timezone): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function localTime(at: number, timeZone = current.timezone): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

export function zoneLabel(at: number, settings = current): string {
  if (settings.timezoneLabel) return settings.timezoneLabel;
  const part = new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
  return part?.value.replace(/\s+/g, '') || settings.timezone;
}

export function zoneOffsetMs(at: number, timeZone = current.timezone): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(at / 1000) * 1000;
}

export function fromLocal(localAsUtc: number, timeZone = current.timezone): number {
  const guess = localAsUtc - zoneOffsetMs(localAsUtc, timeZone);
  return localAsUtc - zoneOffsetMs(guess, timeZone);
}

export function validTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
