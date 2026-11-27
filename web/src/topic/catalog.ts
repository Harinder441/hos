import { useEffect, useState } from 'react';
import type { ComposerConfig, HarnessChoice, HarnessFeatures, ModelsConfig, OwnerInfo, SkillInfo } from '../../../src/api/types.js';
import { client } from '../lib.js';

let models: Promise<ModelsConfig> | undefined;
let composer: Promise<ComposerConfig> | undefined;
let owner: Promise<OwnerInfo> | undefined;
const skills = new Map<string, Promise<SkillInfo[]>>();
let harnesses: Promise<HarnessChoice[]> | undefined;
let loadedHarnesses: HarnessChoice[] | undefined;

function once<T>(load: () => Promise<T>, forget: () => void): Promise<T> {
  return load().catch((error: unknown) => {
    forget();
    throw error;
  });
}

function useLoaded<T>(load: () => Promise<T>, key = ''): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let live = true;
    load().then(
      (loaded) => live && setValue(loaded),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [key]);
  return value;
}

export function useModels(): ModelsConfig | undefined {
  return useLoaded(() => (models ??= once(() => client.models(), () => (models = undefined))));
}

export function useComposer(): ComposerConfig | undefined {
  return useLoaded(() => (composer ??= once(() => client.composer(), () => (composer = undefined))));
}

export function useOwner(): OwnerInfo | undefined {
  return useLoaded(() => (owner ??= once(() => client.owner(), () => (owner = undefined))));
}

export function ownerName(info: OwnerInfo | undefined): string {
  return info?.name ?? 'you';
}

export function useSkills(profile = 'generic'): SkillInfo[] | undefined {
  const load = () => {
    const cached = skills.get(profile);
    if (cached) return cached;
    const loading = once(() => client.skills(profile), () => skills.delete(profile));
    skills.set(profile, loading);
    return loading;
  };
  return useLoaded(load, profile);
}

export function useHarnesses(): HarnessChoice[] | undefined {
  return useLoaded(
    () => (harnesses ??= once(() => client.harnesses().then((list) => (loadedHarnesses = list)), () => (harnesses = undefined))),
  );
}

export function extraHarness(list: HarnessChoice[] | undefined, agent: string | undefined): HarnessChoice | undefined {
  const index = agent === undefined ? -1 : (list?.findIndex((harness) => harness.id === agent || !!harness.aliases?.includes(agent)) ?? -1);
  return index > 0 ? list![index] : undefined;
}

export function badgeText(harness: HarnessChoice | undefined, agent: string, label: string): string {
  return harness?.badge?.aliases?.[agent] ?? harness?.badge?.text ?? label.charAt(0).toUpperCase();
}

export function harnessHas(harness: HarnessChoice | undefined, feature: keyof HarnessFeatures): boolean {
  return !harness || (harness.features?.[feature] ?? false);
}

export function agentLabel(agent: string | undefined): string {
  return extraHarness(loadedHarnesses, agent)?.label ?? 'Claude';
}

export function modelLabel(config: ModelsConfig | undefined, id: string | null): string {
  if (!id) return 'default';
  return config?.list.find((choice) => choice.id === id)?.label ?? id;
}
