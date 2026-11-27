#!/usr/bin/env node
// Stands in for the claude CLI under the Agent SDK: logs its argv and the control requests it gets, answers them.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (entry) => appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
log({ argv: process.argv.slice(2) });
const servers = new Set();
const answers = {
  initialize: () => ({ commands: [], agents: [], models: [], output_style: 'default', available_output_styles: [] }),
  mcp_set_servers: (request) => {
    for (const name of Object.keys(request.servers)) servers.add(name);
    return { added: Object.keys(request.servers), removed: [], errors: {} };
  },
  mcp_status: () => ({ mcpServers: [...servers].map((name) => ({ name, status: process.env.FAKE_CLAUDE_MCP_STATUS ?? 'connected' })) }),
  get_context_usage: () => ({ totalTokens: 0, categories: [], memoryFiles: [], skills: { skillFrontmatter: [] } }),
};
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type !== 'control_request') continue;
  log({ request: message.request });
  const response = answers[message.request.subtype]?.(message.request) ?? {};
  process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })}\n`);
}
