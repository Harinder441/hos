import { useEffect, useState, type CSSProperties } from 'react';
import type { Chat, Effort, ModelsConfig, ProfileInfo } from '../../../src/api/types.js';
import { client } from '../lib.js';

const GENERIC = 'generic';

// Fetched on every open, never cached, so a profile file removed from the brain drops out of the chip.
export function useProfilePick(remembered?: string) {
  const [profiles, setProfiles] = useState<ProfileInfo[]>();
  const [picked, setPicked] = useState<string>();
  useEffect(() => {
    let live = true;
    client.profiles().then(
      (list) => live && setProfiles(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const offered = profiles?.filter((p) => p.picker);
  const profile = [picked, remembered].find((id) => offered?.some((p) => p.id === id)) ?? GENERIC;
  const picker =
    offered && offered.length > 1
      ? { label: 'Profile', value: profile, shown: profile, options: offered.map((p) => ({ value: p.id, label: p.id })), onPick: setPicked }
      : null;
  const info = profiles?.find((p) => p.id === profile);
  return { profile, picker, pick: profile === GENERIC ? {} : { profile }, defaults: info?.defaults, browser: info?.browser ?? false };
}

export function lastProfile(chats: Iterable<Chat>, topicId: string): string | undefined {
  return [...chats].filter((c) => c.topicId === topicId && c.createdBy === 'human').sort((a, b) => b.createdAt - a.createdAt)[0]?.profile;
}

export function profileDefaults(
  defaults: ProfileInfo['defaults'] | undefined,
  harness: string | undefined,
  models: ModelsConfig | undefined,
): { model: string | undefined; effort: Effort | undefined } {
  const own = harness ? defaults?.models[harness] : undefined;
  const model = own?.model && models?.list.some((m) => m.id === own.model) ? own.model : models?.default;
  return { model, effort: own?.effort ?? models?.effort };
}

export function useProfileColors(): Record<string, string> {
  const [colors, setColors] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    client.profiles().then(
      (list) => live && setColors(Object.fromEntries(list.flatMap((p) => (p.color ? [[p.id, p.color]] : [])))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return colors;
}

export function profileStyle(color: string | undefined): { className: string; style?: CSSProperties } {
  return color ? { className: ' profiled', style: { '--profile': color } as CSSProperties } : { className: '' };
}

export function useContextRefresh(profileId: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    client.profiles().then(
      (list) => live && setOn(list.some((p) => p.id === profileId && p.contextRefresh)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [profileId]);
  return on;
}
