import type { AgentEvent } from '../../adapters/agent-runtime.js';
import type { CanonicalTool } from '../tools.js';

export interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  _meta?: Record<string, unknown>;
}

export interface AcpCommand {
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface AcpUpdate extends AcpToolCall {
  sessionUpdate: string;
  status?: string;
  content?: { text?: string };
  rawOutput?: unknown;
  availableCommands?: AcpCommand[];
  configOptions?: AcpConfigOption[];
  currentModeId?: string;
  used?: number;
  size?: number;
}

export interface AcpConfigOption {
  id: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
}

export interface AcpUpdateContext {
  readonly model: string | undefined;
  contextTokens(tokens: number): void;
  credits(credits: number): void;
  emit(event: AgentEvent): void;
}

export interface AcpNotifications {
  onNotification(listener: (method: string, params: Record<string, unknown>) => void): void;
}

export interface AcpHooks {
  tool?(call: AcpToolCall): CanonicalTool | undefined;
  replay?(update: AcpUpdate): boolean;
  newSession?(input: { model?: string; effort?: string; modeId?: string }): Record<string, unknown>;
  update?(update: AcpUpdate, ctx: AcpUpdateContext): void;
  skills?(commands: AcpCommand[]): string[];
  autoAllow?(params: Record<string, unknown>): boolean;
  serverReady?(connection: AcpNotifications, server: string): Promise<boolean>;
}

export interface AcpConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  memoryFiles?: string[];
  modes?: { build?: string; plan?: string };
  modelOption?: string;
  effortOption?: string;
  terminal?: string[];
  login?: string[];
  signedIn?: string[];
  spareTtlMs?: number;
  firstTurnNote?: string;
  unaskedTools?: string[];
  hooks?: AcpHooks;
}

export const SESSION_PLACEHOLDER = '{session}';
export const AGENT_DEFAULT_MODEL = 'default';
