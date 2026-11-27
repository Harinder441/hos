import type { StatusItem } from '../api/types.js';
import type { HarnessSource } from '../plugins/types.js';
import { acpHarness, DEFAULT_ACP_SLOTS, type AcpHarnessSpec } from './acp/index.js';
import { AcpAgentRuntime } from './acp/runtime.js';
import { Harnesses, NO_FEATURES, type Harness } from './harness.js';

export interface HarnessSetup {
  harnesses: Harnesses;
  rows: StatusItem[];
}

export function fromPlugin(source: HarnessSource): Harness {
  const takeover = source.runtime instanceof AcpAgentRuntime ? source.runtime.takeover : false;
  return {
    id: source.id,
    label: source.label,
    pool: source.pool ?? source.id,
    runtime: source.runtime,
    models: () => source.models(),
    slots: source.slots ?? DEFAULT_ACP_SLOTS,
    features: { ...NO_FEATURES, takeover, ...source.features },
    ...(source.aliases?.length ? { aliases: source.aliases } : {}),
    ...(source.badge ? { badge: source.badge } : {}),
  };
}

export function setupHarnesses(
  primary: Harness,
  extras: Harness[],
  settings: { specs: AcpHarnessSpec[]; problems: string[] },
  plugins: Array<{ source: HarnessSource; plugin: string }>,
): HarnessSetup {
  const rows: StatusItem[] = settings.problems.map((detail, i) => ({
    id: `harness-settings:${i}`,
    label: 'Harness settings',
    status: 'warn',
    detail,
    fix: "fix the harnesses list in the brain's hos/policy.yaml, then restart hos",
  }));
  const chosen: Harness[] = [];
  const ids = new Map<string, string>([[primary.id, 'hos itself']]);
  const add = (harness: Harness, from: string) => {
    const names = [harness.id, ...(harness.aliases ?? [])];
    const clash = names.find((name) => ids.has(name));
    if (clash) {
      rows.push({ id: `harness:${harness.id}:clash`, label: `Harness ${harness.label}`, status: 'warn', detail: `${from} offers the harness id ${clash}, which ${ids.get(clash)} already uses; it is not loaded`, fix: 'give it another id, then restart hos' });
      harness.runtime.dispose?.();
      return;
    }
    for (const name of names) ids.set(name, from);
    chosen.push(harness);
  };
  for (const harness of extras) add(harness, 'hos itself');
  for (const spec of settings.specs) add(acpHarness(spec), 'policy.yaml harnesses');
  for (const { source, plugin } of plugins) add(fromPlugin(source), `the plug-in ${plugin}`);
  return { harnesses: new Harnesses(primary, chosen), rows };
}

export async function signInRows(harnesses: Harnesses, signedIn: (harness: Harness) => Promise<boolean | null>): Promise<StatusItem[]> {
  const rows: StatusItem[] = [];
  for (const harness of harnesses.all()) {
    if (harness === harnesses.primary) continue;
    const id = `harness:${harness.id}`;
    const label = `${harness.label} sign-in`;
    const login = harness.runtime.loginCommand?.();
    const state = await signedIn(harness);
    if (state === null) rows.push({ id, label, status: 'off', detail: `the ${harness.label} harness has no sign-in check`, ...(login ? { fix: login.join(' ') } : {}) });
    else if (state) rows.push({ id, label, status: 'ok', detail: 'signed in' });
    else rows.push({ id, label, status: 'down', detail: 'not signed in', fix: login ? login.join(' ') : `sign in to ${harness.label} in a terminal` });
  }
  return rows;
}
