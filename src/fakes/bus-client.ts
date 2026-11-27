import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BusEndpoint } from '../adapters/agent-runtime.js';

export interface BusResult {
  output: string;
  isError: boolean;
}

export async function listBusTools(endpoint: BusEndpoint | undefined): Promise<Array<{ name: string; alwaysLoad: boolean }>> {
  if (!endpoint) return [];
  const client = new Client({ name: 'hos-scripted-agent', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((tool) => ({ name: tool.name, alwaysLoad: (tool._meta as Record<string, unknown> | undefined)?.['anthropic/alwaysLoad'] === true }));
  } finally {
    await client.close().catch(() => {});
  }
}

export async function callBus(
  endpoint: BusEndpoint | undefined,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<BusResult> {
  if (!endpoint) return { output: 'this chat has no bus', isError: true };
  const client = new Client({ name: 'hos-scripted-agent', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    return {
      output: content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n'),
      isError: result.isError === true,
    };
  } catch (error) {
    return { output: error instanceof Error ? error.message : String(error), isError: true };
  } finally {
    await client.close().catch(() => {});
  }
}
