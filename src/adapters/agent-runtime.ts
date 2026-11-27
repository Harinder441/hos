import type { ChatMode, ContextSlice, Effort, SubagentEnd, TranscriptEntry, WindowReadings } from '../api/types.js';
import type { Named } from '../naming.js';
import { ownerStart } from '../owner.js';

export type AgentEvent =
  | { type: 'context.loaded'; memoryFiles: string[]; skills: string[] }
  | { type: 'context.breakdown'; categories: ContextSlice[] }
  | { type: 'turn.started' }
  | { type: 'message.delta'; messageId: string; text: string }
  | { type: 'message.completed'; messageId: string; text: string }
  | { type: 'thinking.delta'; thinkingId: string; text: string }
  | { type: 'thinking.completed'; thinkingId: string; text: string }
  | { type: 'tool.started'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string }
  | { type: 'tool.completed'; toolUseId: string; output: string; isError: boolean; parentToolUseId?: string }
  | { type: 'subagent.started'; toolUseId: string; description: string; agentType: string | null; depth: number; prompt: string }
  | { type: 'subagent.progress'; toolUseId: string; tokens: number; tools: number; durationMs: number; lastTool: string | null }
  | { type: 'subagent.finished'; toolUseId: string; status: SubagentEnd; summary: string; tokens?: number; tools?: number; durationMs?: number }
  | { type: 'shell.started'; taskId: string; description: string }
  | { type: 'shell.finished'; taskId: string }
  | { type: 'context.usage'; tokens: number; compactAt?: number }
  | { type: 'tokens.used'; model: string | null; input: number; output: number; cacheRead: number; cacheCreation: number }
  | { type: 'credits.used'; credits: number }
  | { type: 'provider.limit'; window: 'five_hour' | 'seven_day'; pct: number; resetsAt: number | null }
  | { type: 'context.compacted' }
  | { type: 'turn.completed' }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; limit?: { resetsAt: number | null } };

export interface PermissionRequest {
  toolUseId: string;
  tool: string;
  input: unknown;
  title?: string;
}

export type PermissionDecision = 'approve' | 'deny' | { deny: string } | { answers: Record<string, string> };

export function deniedText(): string {
  return `${ownerStart()} denied this request.`;
}

export function deniedMessage(decision: PermissionDecision): string | undefined {
  if (decision === 'deny') return deniedText();
  return typeof decision === 'object' && 'deny' in decision ? decision.deny : undefined;
}

export interface AgentSink {
  event(event: AgentEvent): void;
  beforeTool(request: PermissionRequest): Promise<string | undefined>;
  permission(request: PermissionRequest): Promise<PermissionDecision>;
  needsDecision(request: PermissionRequest): boolean;
  beforeTurn(): string | undefined;
  refuse(request: PermissionRequest): string | undefined;
  beforeStop(): string | undefined;
  beforeCompact(): string | undefined;
}

export interface BusEndpoint {
  url: string;
  token: string;
}

export interface ExternalMcpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface AgentChatSpec {
  chatId: string;
  cwd: string;
  extraDirs: string[];
  env: Record<string, string>;
  compactAt: number;
  brainDir?: string;
  resume?: string;
  model?: string;
  effort?: Effort;
  mode?: ChatMode;
  chrome?: boolean;
  bus?: BusEndpoint;
  mcpServers?: ExternalMcpServer[];
  hideSkills?: string[];
  allowSkills?: string[];
  hideTools?: string[];
  profileAppend?: string;
}

export interface AgentSession {
  readonly nativeId: string;
  send(text: string): void;
  setMode?(mode: ChatMode): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentRuntime {
  readonly agent: string;
  start(spec: AgentChatSpec, sink: AgentSink): Promise<AgentSession>;
  transcript(nativeId: string, cwd: string): Promise<TranscriptEntry[]>;
  terminalCommand(spec: AgentChatSpec & { resume: string }): Promise<string[]>;
  loginCommand?(): string[];
  signedIn?(): Promise<boolean>;
  usage?(): Promise<WindowReadings | undefined>;
  title?(text: string, areas: string[]): Promise<Named | null>;
  dispose?(): void;
}
