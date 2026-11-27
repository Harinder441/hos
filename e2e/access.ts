import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function virtualAuthenticator(page: Page): Promise<{ addSharedPasskey(): Promise<void> }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    async addSharedPasskey() {
      const shared = JSON.parse(readFileSync(join(process.env.HOS_E2E_DATA_DIR!, 'passkey.json'), 'utf8'));
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { ...shared, isResidentCredential: true, signCount: 0 } });
    },
  };
}

export async function signIn(page: Page): Promise<void> {
  await (await virtualAuthenticator(page)).addSharedPasskey();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expectShell(page);
}

export async function expectShell(page: Page): Promise<void> {
  await expect(page.locator('nav[aria-label="Places"]')).toBeAttached();
  await expect(page.getByRole('main', { name: 'Main' }).getByRole('heading', { level: 1 })).toBeVisible();
}

export async function runCommand(page: Page, label: string): Promise<void> {
  const search = page.getByRole('button', { name: 'Search and commands' });
  if (await search.isVisible()) await search.click();
  else await page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name: 'More' }).click();
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await palette.getByRole('combobox').fill(label);
  await palette.getByRole('option', { name: label, exact: true }).click();
}
