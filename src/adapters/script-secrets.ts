import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface SecretReader {
  read(name: string): Promise<string | null>;
}

export class BrainSecretReader implements SecretReader {
  constructor(private readonly brainDir: string) {}

  async read(name: string): Promise<string | null> {
    try {
      const { stdout } = await run('bash', [join(this.brainDir, 'scripts', 'secret.sh'), name], { timeout: 30_000, killSignal: 'SIGKILL' });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}
