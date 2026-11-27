import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BusReplyFn } from './bus-http.js';
import type { ConfigVault } from './config-vault.js';

export function registerConfigTools(server: McpServer, vault: ConfigVault, reply: BusReplyFn): void {
  server.registerTool(
    'config_sync',
    {
      description: `Sync the hos Config vault (${vault.dir}/<repo>/<path>, edit with Read/Edit/Write): no to → drift list; to → commit vault edits, copy to root/all/named worktrees (.env merges keys).`,
      inputSchema: {
        repo: z.string().min(1).max(100).describe('repo folder in the vault, e.g. web-app'),
        path: z.string().min(1).max(300).optional().describe('file inside the repo, e.g. .env; default every file'),
        to: z.union([z.enum(['root', 'all']), z.array(z.string().min(1).max(200)).min(1).max(50)]).optional().describe("'root', 'all' or worktree names/branches"),
      },
    },
    ({ repo, path, to }) =>
      reply('config_sync', { repo, path, to }, async () => {
        if (!to) {
          const { files, pending } = await vault.drift(repo, path);
          const lines = files.map((f) => `${f.repo}/${f.path}: ${f.targets.map((t) => `${t.name} ${t.state}`).join(', ')}`);
          if (pending.length) lines.push(`not synced yet (vault edits): ${pending.join(', ')}`);
          return { outcome: 'ok', text: lines.length ? lines.join('\n') : 'No drift: every target matches hos Config.' };
        }
        const { files } = await vault.sync(repo, path, to);
        const line = (f: (typeof files)[number]) =>
          [
            `${repo}/${f.path}: ${f.applied.length ? `${f.merged ? 'merged into' : 'copied to'} ${f.applied.join(', ')}` : 'already in sync'}`,
            f.backups.length ? `; backups: ${f.backups.join(', ')}` : '',
            f.errors.length ? `; errors: ${f.errors.join('; ')}` : '',
          ].join('');
        return { outcome: files.some((f) => f.errors.length) ? 'error' : 'ok', text: files.map(line).join('\n') };
      }),
  );
}
