import { defineConfig } from 'vitest/config';
import { pathWithRealGit } from './test/real-git.js';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Real git/daemon tests run ~5x slower when the Mac is busy; snapshot.test.ts reached 14.7 s of 15 s under load (S129).
    testTimeout: 30000,
    // Each file re-imported the whole daemon (~14% of the run); tests share nothing global beyond what they restore.
    isolate: false,
    env: { PATH: pathWithRealGit() },
  },
});
