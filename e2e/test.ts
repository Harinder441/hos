import { expect, test as base } from '@playwright/test';
import { closeTopics } from './fixtures.js';

export { expect };

export const test = base.extend<{ watchPage: void; closeTopics: void }>({
  watchPage: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
      page.on('requestfailed', (request) => {
        const failure = request.failure()?.errorText ?? '';
        if (!/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure)) problems.push(`request failed: ${request.method()} ${request.url()} ${failure}`);
      });
      page.on('response', (response) => {
        if (response.status() >= 500 && response.status() !== 503) problems.push(`server error: ${response.status()} ${response.request().method()} ${response.url()}`);
      });
      await use();
      expect(problems, 'no page errors and no failed requests').toEqual([]);
    },
    { auto: true },
  ],
  closeTopics: [
    async ({}, use) => {
      await use();
      await closeTopics();
    },
    { auto: true },
  ],
});
