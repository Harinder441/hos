import {
  getSessionMessages,
  query,
  type PreToolUseHookInput,
  type Query,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bundledClaude, claudeEnv } from './claude-bin.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptEntry, WindowReadings } from '../api/types.js';
import { TITLE_INPUT_CHARS, TITLE_MODEL, titlePrompt, type Named } from '../naming.js';
import { owner } from '../owner.js';
import { skillHidden } from '../policy.js';
import { turnFailure, turnLimit, turnModel } from './claude-result.js';
import {
  deniedMessage,
  type AgentEvent,
  type AgentChatSpec,
  type AgentRuntime,
  type AgentSession,
  type AgentSink,
} from './agent-runtime.js';

export interface ClaudeRuntimeOptions {
  executable?: string;
  model?: string;
}

const BUS_SERVER = 'hos';
const BUS_CONNECT_MS = 10_000;
const SKILL_LIST_MS = 10 * 60_000;
// The brain's auto-commit Stop hook exits on HOS_CHAT, since hos commits the brain itself (ADR 0010); every other hook keeps running.
const HOS_CHAT_ENV = { HOS_CHAT: '1' } as const;
const HIDDEN_TOOLS = ['Workflow', 'ScheduleWakeup', 'ShareOnboardingGuide', 'ReportFindings', 'ListAgents'];

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly agent = 'claude';
  private readonly live = new Set<Query>();
  private readonly skillLists = new Map<string, { at: number; names: Promise<string[] | null> }>();

  constructor(private readonly options: ClaudeRuntimeOptions = {}) {}

  async usage(): Promise<WindowReadings | undefined> {
    const read = (session: Query) => session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const live = [...this.live][0];
    if (live) return toWindows(await read(live));
    const input = new MessageQueue();
    const probe = query({
      prompt: input,
      options: {
        cwd: tmpdir(),
        env: claudeEnv({}),
        persistSession: false,
        permissionMode: 'default',
        ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
      },
    });
    try {
      return toWindows(await read(probe));
    } finally {
      input.end();
      probe.close();
    }
  }

  private async shownSkills(spec: AgentChatSpec, directories: string[], hide: string[], allow: string[] | undefined): Promise<string[] | null> {
    const key = JSON.stringify([spec.cwd, directories]);
    let cached = this.skillLists.get(key);
    if (!cached || Date.now() - cached.at > SKILL_LIST_MS) {
      cached = { at: Date.now(), names: this.allSkills(spec.cwd, directories) };
      this.skillLists.set(key, cached);
    }
    const names = await cached.names;
    if (!names) this.skillLists.delete(key);
    return names && names.filter((name) => !skillHidden(hide, name) && (!allow || allow.includes(name)));
  }

  // An explicit skills list also hides the built-in skills, so the full list comes from a session that loads everything.
  private async allSkills(cwd: string, directories: string[]): Promise<string[] | null> {
    const input = new MessageQueue();
    const probe = query({
      prompt: input,
      options: {
        cwd,
        env: claudeEnv({ ...HOS_CHAT_ENV }),
        persistSession: false,
        permissionMode: 'default',
        ...(directories.length ? { additionalDirectories: directories } : {}),
        ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
      },
    });
    try {
      return ((await probe.getContextUsage({ detail: 'summary' })).skills?.skillFrontmatter ?? []).map((skill) => skill.name);
    } catch (error) {
      console.error(`listing skills for ${cwd} failed, so no skill is hidden:`, error);
      return null;
    } finally {
      input.end();
      probe.close();
    }
  }

  async title(text: string, areas: string[]): Promise<Named | null> {
    const properties = areas.length ? { title: { type: 'string' }, area: { type: 'string', enum: [...new Set([...areas, 'misc'])] } } : { title: { type: 'string' } };
    const naming = query({
      prompt: `<message>\n${text.slice(0, TITLE_INPUT_CHARS)}\n</message>`,
      options: {
        cwd: tmpdir(),
        env: claudeEnv({}),
        model: TITLE_MODEL,
        systemPrompt: titlePrompt(areas),
        tools: [],
        mcpServers: {},
        settingSources: [],
        maxTurns: 3,
        persistSession: false,
        thinking: { type: 'disabled' },
        outputFormat: { type: 'json_schema', schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } },
        ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
      },
    });
    for await (const message of naming) {
      if (message.type !== 'result') continue;
      const output = message.subtype === 'success' ? (message.structured_output as { title?: unknown; area?: unknown } | undefined) : undefined;
      return typeof output?.title === 'string' ? { title: output.title, area: typeof output.area === 'string' ? output.area : null } : null;
    }
    return null;
  }

  async start(spec: AgentChatSpec, sink: AgentSink): Promise<AgentSession> {
    const sessionId = spec.resume ?? randomUUID();
    const resuming = spec.resume !== undefined && (await getSessionMessages(spec.resume, { dir: spec.cwd, limit: 1 })).length > 0;
    const input = new MessageQueue();
    const inBrain = spec.brainDir !== undefined && spec.cwd === spec.brainDir;
    const append = await systemAppend(spec, inBrain);
    const directories = [...(spec.brainDir && !inBrain ? [spec.brainDir] : []), ...spec.extraDirs];
    const shown = spec.hideSkills?.length || spec.allowSkills ? await this.shownSkills(spec, directories, spec.hideSkills ?? [], spec.allowSkills) : null;
    const mcpServers = {
      ...Object.fromEntries((spec.mcpServers ?? []).map(({ name, url, headers }) => [name, { type: 'http' as const, url, headers }])),
      ...(spec.bus ? { [BUS_SERVER]: { type: 'http' as const, url: spec.bus.url, headers: { authorization: `Bearer ${spec.bus.token}` } } } : {}),
    };
    const session = query({
      prompt: input,
      options: {
        cwd: spec.cwd,
        ...(resuming ? { resume: sessionId } : { sessionId }),
        ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
        ...((spec.model ?? this.options.model) ? { model: spec.model ?? this.options.model } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
        ...(/haiku/i.test(spec.model ?? this.options.model ?? '') ? {} : { thinking: { type: 'adaptive', display: 'summarized' } as const }),
        ...(directories.length ? { additionalDirectories: directories } : {}),
        env: claudeEnv({
          ...spec.env,
          ...HOS_CHAT_ENV,
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactionWindow(spec.compactAt)),
        }),
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) },
        permissionMode: 'default',
        settings: { crossSessionInbound: 'refuse' },
        ...(spec.chrome ? { extraArgs: { chrome: null } } : {}),
        disallowedTools: [...HIDDEN_TOOLS, ...(spec.hideTools ?? [])],
        ...(shown ? { skills: shown } : {}),
        includePartialMessages: true,
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                async () => {
                  const additionalContext = sink.beforeTurn();
                  return additionalContext
                    ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
                    : {};
                },
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                async (hookInput) => {
                  const { tool_name, tool_input, tool_use_id } = hookInput as PreToolUseHookInput;
                  const request = { toolUseId: tool_use_id, tool: tool_name, input: tool_input };
                  const refused = sink.refuse(request) ?? (await sink.beforeTool(request));
                  if (refused) {
                    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refused } };
                  }
                  if (!sink.needsDecision(request)) return {};
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'ask',
                      permissionDecisionReason: `hos policy asks ${owner()}`,
                    },
                  };
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                async () => {
                  const reason = sink.beforeStop();
                  return reason ? { decision: 'block', reason } : {};
                },
              ],
            },
          ],
          PreCompact: [
            {
              hooks: [
                async () => {
                  const reason = sink.beforeCompact();
                  return reason ? { decision: 'block', reason } : {};
                },
              ],
            },
          ],
        },
        canUseTool: async (tool, toolInput, { toolUseID, title }) => {
          if (tool.startsWith(`mcp__${BUS_SERVER}__`)) return { behavior: 'allow', updatedInput: toolInput };
          const refused = sink.refuse({ toolUseId: toolUseID, tool, input: toolInput });
          if (refused) return { behavior: 'deny', message: refused };
          const decision = await sink.permission({ toolUseId: toolUseID, tool, input: toolInput, ...(title ? { title } : {}) });
          const denied = deniedMessage(decision);
          if (denied) return { behavior: 'deny', message: denied };
          return { behavior: 'allow', updatedInput: typeof decision === 'object' && 'answers' in decision ? { ...toolInput, answers: decision.answers } : toolInput };
        },
      },
    });
    let closed = false;
    let brokenDown = resuming;
    this.live.add(session);
    const translate = translator(sink);
    void (async () => {
      try {
        for await (const message of session) {
          if (message.type === 'result') {
            const first = !brokenDown;
            const usage = await session.getContextUsage({ detail: first ? 'full' : 'summary' }).catch(() => undefined);
            if (usage) {
              sink.event({
                type: 'context.usage',
                tokens: usage.totalTokens,
                ...(usage.autoCompactThreshold ? { compactAt: usage.autoCompactThreshold } : {}),
              });
              if (first) {
                brokenDown = true;
                const categories = usage.categories.filter((c) => c.kind === 'used' && c.tokens > 0).map((c) => ({ name: c.name, tokens: c.tokens }));
                sink.event({ type: 'context.breakdown', categories });
              }
            }
          }
          translate(message);
        }
      } catch (error) {
        if (!closed) sink.event({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    const stop = async () => {
      closed = true;
      this.live.delete(session);
      input.end();
      session.close();
    };
    // Not the mcpServers option (`--mcp-config` on argv, readable with ps); start still waits for every server, as the CLI answers getContextUsage after this.
    if (Object.keys(mcpServers).length) {
      void session.setMcpServers(mcpServers).then(
        ({ errors }) => {
          for (const [name, message] of Object.entries(errors)) console.warn(`MCP server ${name} did not connect to the Claude chat: ${message}`);
        },
        (error: unknown) => {
          if (!closed) console.warn('passing MCP servers to the Claude chat failed:', error);
        },
      );
    }
    const usage = await session.getContextUsage({ detail: 'summary' }).catch(async (error: unknown) => {
      await stop();
      throw error;
    });
    if (spec.bus && !(await busConnected(session))) {
      sink.event({ type: 'warning', message: `The hos bus did not connect within ${BUS_CONNECT_MS / 1000} s, so this chat has no hos tools; restart the chat to retry.` });
    }
    sink.event({
      type: 'context.loaded',
      memoryFiles: usage.memoryFiles.map((file) => file.path),
      skills: (usage.skills?.skillFrontmatter ?? []).map((skill) => skill.name),
    });
    return {
      nativeId: sessionId,
      send(text) {
        input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      },
      stop,
    };
  }

  async terminalCommand(spec: AgentChatSpec & { resume: string }): Promise<string[]> {
    const resuming = (await getSessionMessages(spec.resume, { dir: spec.cwd, limit: 1 })).length > 0;
    const inBrain = spec.brainDir !== undefined && spec.cwd === spec.brainDir;
    const append = await systemAppend(spec, inBrain);
    const directories = [...(spec.brainDir && !inBrain ? [spec.brainDir] : []), ...spec.extraDirs];
    return [
      'sh',
      '-c',
      STRIP_SESSION_ENV,
      'claude',
      'env',
      'HOS_CHAT=1',
      `CLAUDE_CODE_AUTO_COMPACT_WINDOW=${compactionWindow(spec.compactAt)}`,
      this.options.executable ?? bundledClaude(),
      resuming ? '--resume' : '--session-id',
      spec.resume,
      '--permission-mode',
      'default',
      ...((spec.model ?? this.options.model) ? ['--model', (spec.model ?? this.options.model)!] : []),
      ...(spec.effort ? ['--effort', spec.effort] : []),
      ...(spec.chrome ? ['--chrome'] : []),
      ...directories.flatMap((dir) => ['--add-dir', dir]),
      ...(append ? ['--append-system-prompt', append] : []),
    ];
  }

  loginCommand(): string[] {
    return ['sh', '-c', STRIP_SESSION_ENV, 'claude', this.options.executable ?? bundledClaude(), 'auth', 'login'];
  }

  async transcript(nativeId: string, cwd: string): Promise<TranscriptEntry[]> {
    const messages = await getSessionMessages(nativeId, { dir: cwd });
    return messages
      .filter((message) => message.parent_tool_use_id === null)
      .flatMap((message) => toTranscript(message.type, (message.message as { content?: unknown })?.content));
  }
}

const STRIP_SESSION_ENV = [
  'for v in $(env | cut -d= -f1); do',
  'case "$v" in CLAUDE_CONFIG_DIR) ;; CLAUDE*|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN) unset "$v" ;; esac;',
  'done; exec "$@"',
].join(' ');

async function busConnected(session: Query): Promise<boolean> {
  const deadline = Date.now() + BUS_CONNECT_MS;
  while (Date.now() < deadline) {
    const status = (await session.mcpServerStatus()).find((server) => server.name === BUS_SERVER)?.status;
    if (status === 'connected') return true;
    if (status !== undefined && status !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.warn(`hos bus did not connect to the Claude chat within ${BUS_CONNECT_MS} ms`);
  return false;
}

function translator(sink: AgentSink): (message: SDKMessage) => void {
  let inTurn = false;
  let apiMessageId = '';
  let model: string | null = null;
  let rejectedUntil: number | null = null;
  const texts = new Map<number, { messageId: string; text: string }>();
  const thoughts = new Map<number, { thinkingId: string; text: string }>();
  const tasks = new Map<string, string>();
  const shells = new Map<string, string>();
  const backgrounded = new Set<string>();
  const shellStarted = (taskId: string) => {
    if (backgrounded.has(taskId) || !shells.has(taskId)) return;
    backgrounded.add(taskId);
    sink.event({ type: 'shell.started', taskId, description: shells.get(taskId)! });
  };
  const shellFinished = (taskId: string) => {
    shells.delete(taskId);
    if (backgrounded.delete(taskId)) sink.event({ type: 'shell.finished', taskId });
  };
  const finished = new Set<string>();
  const finish = (toolUseId: string, event: Omit<Extract<AgentEvent, { type: 'subagent.finished' }>, 'type' | 'toolUseId'>) => {
    if (finished.has(toolUseId)) return;
    finished.add(toolUseId);
    sink.event({ type: 'subagent.finished', toolUseId, ...event });
  };
  return (message) => {
    const parent = 'parent_tool_use_id' in message ? message.parent_tool_use_id : null;
    if (parent) {
      if (message.type === 'assistant') {
        for (const block of message.message.content as ContentBlock[]) {
          if (block.type === 'tool_use') sink.event({ type: 'tool.started', toolUseId: block.id!, name: block.name!, input: block.input, parentToolUseId: parent });
        }
      }
      if (message.type === 'user' && Array.isArray(message.message.content)) {
        for (const block of message.message.content as ContentBlock[]) {
          if (block.type !== 'tool_result') continue;
          sink.event({ type: 'tool.completed', toolUseId: block.tool_use_id!, output: resultText(block.content), isError: block.is_error === true, parentToolUseId: parent });
        }
      }
      return;
    }
    switch (message.type) {
      case 'stream_event': {
        if (!inTurn) {
          inTurn = true;
          sink.event({ type: 'turn.started' });
        }
        const event = message.event;
        if (event.type === 'message_start') apiMessageId = event.message.id;
        if (event.type === 'content_block_start' && event.content_block.type === 'text') {
          texts.set(event.index, { messageId: `${apiMessageId}:${event.index}`, text: '' });
        }
        if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
          thoughts.set(event.index, { thinkingId: `${apiMessageId}:${event.index}`, text: '' });
        }
        if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
          const thought = thoughts.get(event.index);
          if (!thought) return;
          thought.text += event.delta.thinking;
          sink.event({ type: 'thinking.delta', thinkingId: thought.thinkingId, text: event.delta.thinking });
        }
        if (event.type === 'content_block_stop' && thoughts.has(event.index)) {
          const thought = thoughts.get(event.index)!;
          thoughts.delete(event.index);
          sink.event({ type: 'thinking.completed', thinkingId: thought.thinkingId, text: thought.text });
          return;
        }
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const block = texts.get(event.index);
          if (!block) return;
          block.text += event.delta.text;
          sink.event({ type: 'message.delta', messageId: block.messageId, text: event.delta.text });
        }
        if (event.type === 'content_block_stop') {
          const block = texts.get(event.index);
          if (!block) return;
          texts.delete(event.index);
          sink.event({ type: 'message.completed', messageId: block.messageId, text: block.text });
        }
        return;
      }
      case 'assistant':
        model = message.message.model ?? model;
        for (const block of message.message.content as ContentBlock[]) {
          if (block.type === 'tool_use') sink.event({ type: 'tool.started', toolUseId: block.id!, name: block.name!, input: block.input });
        }
        return;
      case 'user':
        if (!Array.isArray(message.message.content)) return;
        for (const block of message.message.content as ContentBlock[]) {
          if (block.type !== 'tool_result') continue;
          sink.event({
            type: 'tool.completed',
            toolUseId: block.tool_use_id!,
            output: resultText(block.content),
            isError: block.is_error === true,
          });
        }
        return;
      case 'rate_limit_event':
        if (message.rate_limit_info.status === 'rejected' && message.rate_limit_info.resetsAt) rejectedUntil = message.rate_limit_info.resetsAt * 1000;
        for (const limit of rateLimits(message.rate_limit_info)) sink.event({ type: 'provider.limit', ...limit });
        return;
      case 'system':
        if (message.subtype === 'compact_boundary') sink.event({ type: 'context.compacted' });
        if (message.subtype === 'task_started' && message.task_type === 'local_bash' && !message.ambient && !message.skip_transcript) {
          shells.set(message.task_id, message.description);
          if (message.is_backgrounded) shellStarted(message.task_id);
          return;
        }
        if (message.subtype === 'task_started') {
          if (!message.tool_use_id || message.ambient || message.skip_transcript) return;
          if (message.task_type && message.task_type !== 'local_agent') return;
          tasks.set(message.task_id, message.tool_use_id);
          sink.event({
            type: 'subagent.started',
            toolUseId: message.tool_use_id,
            description: message.description,
            agentType: message.subagent_type ?? null,
            depth: message.spawn_depth ?? 1,
            prompt: message.prompt ?? '',
          });
        }
        if (message.subtype === 'task_progress') {
          const toolUseId = tasks.get(message.task_id);
          if (!toolUseId) return;
          const { total_tokens, tool_uses, duration_ms } = message.usage;
          sink.event({ type: 'subagent.progress', toolUseId, tokens: total_tokens, tools: tool_uses, durationMs: duration_ms, lastTool: message.last_tool_name ?? null });
        }
        if (message.subtype === 'task_updated' && shells.has(message.task_id)) {
          const status = message.patch.status;
          if (status === 'completed' || status === 'failed' || status === 'killed') return shellFinished(message.task_id);
          if (message.patch.is_backgrounded) shellStarted(message.task_id);
          return;
        }
        if (message.subtype === 'task_updated') {
          const toolUseId = tasks.get(message.task_id);
          const status = message.patch.status;
          if (!toolUseId || (status !== 'failed' && status !== 'killed')) return;
          finish(toolUseId, { status: status === 'killed' ? 'stopped' : 'failed', summary: message.patch.error ?? '' });
        }
        if (message.subtype === 'task_notification' && shells.has(message.task_id)) return shellFinished(message.task_id);
        if (message.subtype === 'task_notification') {
          const toolUseId = tasks.get(message.task_id);
          if (!toolUseId) return;
          const usage = message.usage ? { tokens: message.usage.total_tokens, tools: message.usage.tool_uses, durationMs: message.usage.duration_ms } : {};
          finish(toolUseId, { status: message.status, summary: message.summary, ...usage });
        }
        return;
      case 'result':
        inTurn = false;
        sink.event({
          type: 'tokens.used',
          model: turnModel(model, message),
          input: message.usage.input_tokens ?? 0,
          output: message.usage.output_tokens ?? 0,
          cacheRead: message.usage.cache_read_input_tokens ?? 0,
          cacheCreation: message.usage.cache_creation_input_tokens ?? 0,
        });
        if (message.subtype === 'success' && !message.is_error) return sink.event({ type: 'turn.completed' });
        const limit = turnLimit(message);
        return sink.event({ type: 'error', message: turnFailure(message), ...(limit ? { limit: { resetsAt: limit.resetsAt ?? rejectedUntil } } : {}) });
    }
  };
}

type LimitWindow = 'five_hour' | 'seven_day';

const WINDOWS: readonly string[] = ['five_hour', 'seven_day'];

function rateLimits(info: SDKRateLimitInfo): Array<{ window: LimitWindow; pct: number; resetsAt: number | null }> {
  const percent = (utilization: number) => (utilization <= 1 ? utilization * 100 : utilization);
  const at = (seconds: number | undefined) => (seconds ? seconds * 1000 : null);
  const unified = (info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> }).unifiedWindows ?? {};
  const limits = new Map<LimitWindow, { pct: number; resetsAt: number | null }>();
  for (const [window, value] of Object.entries(unified)) {
    if (WINDOWS.includes(window) && value.utilization !== undefined) {
      limits.set(window as LimitWindow, { pct: percent(value.utilization), resetsAt: at(value.resetsAt) });
    }
  }
  const type = info.rateLimitType;
  if (type && WINDOWS.includes(type)) {
    const known = limits.get(type as LimitWindow);
    const pct = info.status === 'rejected' ? 100 : info.utilization !== undefined ? percent(info.utilization) : known?.pct;
    if (pct !== undefined) limits.set(type as LimitWindow, { pct, resetsAt: at(info.resetsAt) ?? known?.resetsAt ?? null });
  }
  return [...limits].map(([window, value]) => ({ window, ...value }));
}

function toWindows(answer: SDKControlGetUsageResponse): WindowReadings | undefined {
  const limits = answer.rate_limits;
  if (!answer.rate_limits_available || !limits) return undefined;
  const reading = (window: { utilization: number | null; resets_at: string | null } | null | undefined) =>
    window && window.utilization !== null ? { pct: window.utilization, resetsAt: window.resets_at ? Date.parse(window.resets_at) : null } : null;
  return { fiveHour: reading(limits.five_hour), weekly: reading(limits.seven_day) };
}

function toTranscript(type: string, content: unknown): TranscriptEntry[] {
  if (typeof content === 'string') return type === 'user' ? [{ kind: 'user', text: content }] : [{ kind: 'assistant', text: content }];
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).flatMap((block): TranscriptEntry[] => {
    if (block.type === 'text') return [{ kind: type === 'user' ? 'user' : 'assistant', text: block.text ?? '' }];
    if (block.type === 'tool_use') return [{ kind: 'tool_use', toolUseId: block.id!, name: block.name!, input: block.input }];
    if (block.type === 'tool_result') {
      return [{ kind: 'tool_result', toolUseId: block.tool_use_id!, output: resultText(block.content), isError: block.is_error === true }];
    }
    return [];
  });
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[]).map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n');
}

// The brain's CLAUDE.md (and the files it @-imports) is delivered through the system prompt, not as a memory file from
// an additional directory, so a chat whose cwd is a worktree still gets the brain's rules while reference workspaces
// attached as extra dirs never leak their own CLAUDE.md into the chat (H1).
async function systemAppend(spec: AgentChatSpec, inBrain: boolean): Promise<string> {
  const brain = spec.brainDir && !inBrain ? await brainImports(spec.brainDir) : '';
  return [brain, spec.profileAppend ?? ''].filter(Boolean).join('\n\n');
}

async function brainImports(brainDir: string): Promise<string> {
  const claudeMd = await readFile(join(brainDir, 'CLAUDE.md'), 'utf8').catch(() => '');
  if (!claudeMd) return '';
  const imports = claudeMd.split('\n').flatMap((line) => /^@(\S+)$/.exec(line.trim())?.[1] ?? []);
  const files = await Promise.all(
    imports.map(async (path) => {
      const file = join(brainDir, path);
      const text = await readFile(file, 'utf8').catch(() => undefined);
      return text === undefined ? '' : `Contents of ${file} (imported by the brain's CLAUDE.md):\n\n${text}`;
    }),
  );
  const brain = `Contents of ${join(brainDir, 'CLAUDE.md')} (the brain's CLAUDE.md):\n\n${claudeMd}`;
  return [brain, ...files].filter(Boolean).join('\n\n');
}

// The CLI auto-compacts 33k below CLAUDE_CODE_AUTO_COMPACT_WINDOW (measured on CLI 2.1.286, opus 1M and haiku).
const COMPACTION_RESERVE = 33_000;

function compactionWindow(compactAt: number): number {
  return Math.min(Math.max(compactAt + COMPACTION_RESERVE, 100_000), 1_000_000);
}

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(item: SDKUserMessage): void {
    this.items.push(item);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}
