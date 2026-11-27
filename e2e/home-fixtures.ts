import { expect, type Locator } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function exclusive<T>(name: string, run: () => Promise<T>): Promise<T> {
  const lock = join(process.env.HOS_E2E_DATA_DIR!, `${name}.lock`);
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function withBrainActions<T>(yaml: string | null, run: () => Promise<T>): Promise<T> {
  return exclusive('brain-actions', async () => {
    const file = join(process.env.HOS_E2E_BRAIN!, 'hos', 'actions.yaml');
    try {
      if (yaml === null) rmSync(file, { force: true });
      else {
        mkdirSync(join(process.env.HOS_E2E_BRAIN!, 'hos'), { recursive: true });
        writeFileSync(file, yaml);
      }
      return await run();
    } finally {
      rmSync(file, { force: true });
    }
  });
}

const INTERNALS = /\btokens?\b|\bslots?\b|\bcontext\b|\bledger\b|\bcache reads?\b/i;

export async function expectNoInternalNumbers(region: Locator): Promise<void> {
  const text = await region.innerText();
  expect(text, 'no token, context, slot or ledger readings').not.toMatch(INTERNALS);
  expect(text).not.toMatch(/\b\d{1,3}(,\d{3})+\b/);
}
