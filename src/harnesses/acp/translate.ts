import { randomUUID } from 'node:crypto';
import type { AgentSink } from '../../adapters/agent-runtime.js';
import type { CanonicalTool } from '../tools.js';
import type { AcpConfigOption, AcpHooks, AcpUpdate, AcpUpdateContext } from './config.js';
import { canonicalTool } from './tools.js';

export class AcpTranslator {
  readonly tools = new Map<string, CanonicalTool>();
  skills: string[] = [];
  config = new Map<string, AcpConfigOption>();
  modeId: string | undefined;
  private readonly open = new Set<string>();
  private segment: { id: string; text: string } | null = null;
  private thinking: { id: string; text: string } | null = null;
  private contextTokens: number | null = null;
  private credits = 0;
  private readonly ctx: AcpUpdateContext;

  constructor(
    private readonly sink: AgentSink,
    private readonly hooks: AcpHooks,
    model: string | undefined,
  ) {
    this.ctx = {
      model,
      contextTokens: (tokens) => {
        this.contextTokens = tokens;
      },
      credits: (credits) => {
        this.credits += credits;
      },
      emit: (event) => sink.event(event),
    };
  }

  update(update: AcpUpdate): void {
    if (update.sessionUpdate === 'agent_message_chunk') return this.chunk(update.content?.text ?? '');
    if (update.sessionUpdate === 'agent_thought_chunk') return this.thought(update.content?.text ?? '');
    if (update.sessionUpdate === 'available_commands_update') {
      this.skills = this.hooks.skills?.(update.availableCommands ?? []) ?? [];
      return;
    }
    if (update.sessionUpdate === 'config_option_update') return this.options(update.configOptions ?? []);
    if (update.sessionUpdate === 'current_mode_update') {
      this.modeId = update.currentModeId;
      return;
    }
    if (update.sessionUpdate === 'usage_update' && typeof update.used === 'number') {
      this.contextTokens = update.used;
      return;
    }
    if (update.sessionUpdate === 'tool_call' && update.toolCallId && !this.tools.has(update.toolCallId)) {
      this.closeThinking();
      this.closeSegment();
      const tool = canonicalTool(update, this.hooks);
      this.tools.set(update.toolCallId, tool);
      this.open.add(update.toolCallId);
      return this.sink.event({ type: 'tool.started', toolUseId: update.toolCallId, name: tool.name, input: tool.input });
    }
    if (update.sessionUpdate === 'tool_call_update' && update.toolCallId && (update.status === 'completed' || update.status === 'failed')) {
      return this.complete(update.toolCallId, outputText(update.rawOutput), update.status === 'failed');
    }
    this.hooks.update?.(update, this.ctx);
  }

  options(options: AcpConfigOption[]): void {
    for (const option of options) this.config.set(option.id, option);
  }

  value(id: string): string | undefined {
    return this.config.get(id)?.currentValue;
  }

  values(id: string): string[] {
    return (this.config.get(id)?.options ?? []).map((option) => option.value);
  }

  rejected(toolUseId: string, message: string): void {
    this.complete(toolUseId, message, true);
  }

  endTurn(): void {
    this.closeThinking();
    this.closeSegment();
    for (const id of [...this.open]) this.complete(id, '', true);
    if (this.contextTokens !== null) this.sink.event({ type: 'context.usage', tokens: Math.round(this.contextTokens) });
    if (this.credits > 0) this.sink.event({ type: 'credits.used', credits: this.credits });
    this.credits = 0;
  }

  private thought(text: string): void {
    if (!text) return;
    this.thinking ??= { id: randomUUID(), text: '' };
    this.thinking.text += text;
    this.sink.event({ type: 'thinking.delta', thinkingId: this.thinking.id, text });
  }

  private closeThinking(): void {
    if (!this.thinking) return;
    this.sink.event({ type: 'thinking.completed', thinkingId: this.thinking.id, text: this.thinking.text });
    this.thinking = null;
  }

  private chunk(text: string): void {
    if (!text) return;
    this.closeThinking();
    this.segment ??= { id: randomUUID(), text: '' };
    this.segment.text += text;
    this.sink.event({ type: 'message.delta', messageId: this.segment.id, text });
  }

  private complete(toolUseId: string, output: string, isError: boolean): void {
    if (!this.open.delete(toolUseId)) return;
    this.sink.event({ type: 'tool.completed', toolUseId, output, isError });
  }

  private closeSegment(): void {
    if (!this.segment) return;
    this.sink.event({ type: 'message.completed', messageId: this.segment.id, text: this.segment.text });
    this.segment = null;
  }
}

export function outputText(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  const raw = output as { output?: unknown; message?: unknown; items?: Array<{ Text?: string; Json?: unknown }> };
  if (typeof raw.output === 'string') return raw.output;
  if (typeof raw.message === 'string') return raw.message;
  if (Array.isArray(raw.items)) return raw.items.map((item) => item.Text ?? JSON.stringify(item.Json ?? '')).join('\n');
  return JSON.stringify(output);
}
