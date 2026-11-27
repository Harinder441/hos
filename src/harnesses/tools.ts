export interface CanonicalTool {
  name: string;
  input: Record<string, unknown>;
}

export const TOOL = {
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  multiEdit: 'MultiEdit',
  notebookEdit: 'NotebookEdit',
  webFetch: 'WebFetch',
  webSearch: 'WebSearch',
  agent: 'Agent',
  task: 'Task',
} as const;

export const READ_TOOLS: readonly string[] = [
  TOOL.read,
  TOOL.glob,
  TOOL.grep,
  'LS',
  'NotebookRead',
  'TodoWrite',
  'Skill',
  'ToolSearch',
  'BashOutput',
  'TaskOutput',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
];

export const EDIT_TOOL_FIELDS: Readonly<Record<string, string>> = {
  [TOOL.write]: 'file_path',
  [TOOL.edit]: 'file_path',
  [TOOL.multiEdit]: 'file_path',
  [TOOL.notebookEdit]: 'notebook_path',
};

export const SHELL_TOOLS: readonly string[] = [TOOL.bash];
export const WEB_TOOLS: readonly string[] = [TOOL.webFetch, TOOL.webSearch];
export const AGENT_TOOLS: readonly string[] = [TOOL.agent, TOOL.task];
export const HOS_TOOL_PREFIX = 'mcp__hos__';

export function mcpTool(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export const TOOL_NAMES = {
  read: READ_TOOLS,
  edit: Object.keys(EDIT_TOOL_FIELDS),
  shell: SHELL_TOOLS,
  web: WEB_TOOLS,
  agent: AGENT_TOOLS,
  hosPrefix: HOS_TOOL_PREFIX,
  mcp: 'mcp__<server>__<tool>',
};

export function refusalNote(refused: string[]): string {
  return ['[hos] The agent showed you a bare denial. hos refused these tool calls, and this is why:', ...refused.map((line) => `- ${line}`)].join('\n');
}
