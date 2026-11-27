import { createRequire } from 'node:module';

export function bundledClaude(): string {
  try {
    return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  } catch {
    return 'claude';
  }
}

export function claudeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('CLAUDE') && key !== 'CLAUDE_CONFIG_DIR') continue;
    if (key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN') continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
