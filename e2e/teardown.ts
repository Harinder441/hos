import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default function teardown(): void {
  try {
    execFileSync('tmux', ['-S', join(process.env.HOS_E2E_DATA_DIR!, 'tmux.sock'), 'kill-server'], { stdio: 'ignore' });
  } catch {}
}
