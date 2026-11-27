import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMode, TranscriptEntry } from '../../api/types.js';
import { deniedMessage, type AgentChatSpec, type AgentRuntime, type AgentSession, type AgentSink } from '../../adapters/agent-runtime.js';
import { HOS_TOOL_PREFIX, refusalNote } from '../tools.js';
import { AGENT_DEFAULT_MODEL, SESSION_PLACEHOLDER, type AcpConfig, type AcpConfigOption, type AcpHooks, type AcpUpdate } from './config.js';
import { AcpConnection } from './connection.js';
import { SpareSlot } from './spare.js';
import { canonicalTool } from './tools.js';
import { AcpTranslator, outputText } from './translate.js';

const HOS_SERVER = 'hos';
const BUS_CONNECT_MS = 10_000;
const SIGNED_IN_MS = 10_000;
const CONTEXT_OPEN = '<hos-context>';
const CONTEXT_CLOSE = '</hos-context>';
const RECENT_TRANSCRIPTS = 20;
const PLAN_MODE = 'plan';
const INITIALIZE = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'hos', version: '1' },
};

type Outcome = 'allow_once' | 'reject_once';

interface PermissionOption {
  optionId: string;
  kind?: string;
}

interface SessionResult {
  sessionId?: string;
  configOptions?: AcpConfigOption[];
  modes?: { currentModeId?: string; availableModes?: Array<{ id: string }> };
}

interface Link {
  acp: AcpConnection;
  sessionId: string;
  modes: SessionResult['modes'];
}

interface TurnFlags {
  cancelledByHos: boolean;
}

export class AcpAgentRuntime implements AgentRuntime {
  private readonly live = new Map<string, TranscriptEntry[]>();
  private readonly recent = new Map<string, TranscriptEntry[]>();
  private readonly spare: SpareSlot<AcpConnection> | undefined;
  private readonly hooks: AcpHooks;
  readonly loginCommand: (() => string[]) | undefined;
  readonly signedIn: (() => Promise<boolean>) | undefined;

  constructor(
    readonly agent: string,
    private readonly config: AcpConfig,
  ) {
    this.hooks = config.hooks ?? {};
    const login = config.login;
    this.loginCommand = login?.length ? () => [...login] : undefined;
    const probe = config.signedIn;
    this.signedIn = probe?.length ? () => exitsZero(probe, this.env({})) : undefined;
    if (config.spareTtlMs !== undefined) {
      this.spare = new SpareSlot(config.spareTtlMs, async (cwd, extra) => {
        const acp = AcpConnection.spawn(this.command(), cwd, this.env(extra));
        try {
          await acp.request('initialize', INITIALIZE);
        } catch (error) {
          acp.close();
          throw error;
        }
        return acp;
      });
    }
  }

  get takeover(): boolean {
    return (this.config.terminal?.length ?? 0) > 0;
  }

  dispose(): void {
    this.spare?.dispose();
  }

  async start(spec: AgentChatSpec, sink: AgentSink): Promise<AgentSession> {
    const hooks = this.hooks;
    const translate = new AcpTranslator(sink, hooks, spec.model);
    const entries: TranscriptEntry[] = [];
    const decided = new Map<string, Outcome>();
    const refusals: string[] = [];
    const flags: TurnFlags = { cancelledByHos: false };
    const unasked = new Set(this.config.unaskedTools ?? []);
    let announced: string[] | undefined;
    const announce = async () => {
      announced = translate.skills;
      sink.event({ type: 'context.loaded', memoryFiles: await memoryFiles(spec.cwd, this.config.memoryFiles ?? ['AGENTS.md']), skills: announced });
    };
    // A tool the agent runs without asking can only be stopped by cancelling the turn.
    const gate = async (acp: AcpConnection, sessionId: string, toolUseId: string) => {
      const tool = translate.tools.get(toolUseId)!;
      const request = { toolUseId, tool: tool.name, input: tool.input };
      const refused = sink.refuse(request) ?? (await sink.beforeTool(request));
      if (!refused) return;
      decided.set(toolUseId, 'reject_once');
      translate.rejected(toolUseId, refused);
      refusals.push(`${tool.name}: ${refused}`);
      flags.cancelledByHos = true;
      acp.notify('session/cancel', { sessionId });
    };
    const observe = (acp: AcpConnection, sessionId: string, update: AcpUpdate, started: boolean) => {
      if (update.sessionUpdate === 'available_commands_update' && announced && !sameList(announced, translate.skills)) void announce();
      if (started && unasked.has(translate.tools.get(update.toolCallId!)?.name ?? '')) void gate(acp, sessionId, update.toolCallId!);
    };
    const permission = async (params: Record<string, unknown>) => {
      const call = params.toolCall as { toolCallId: string; title?: string; kind?: string; rawInput?: unknown; _meta?: Record<string, unknown> };
      const options = (params.options as PermissionOption[] | undefined) ?? [];
      const tool = translate.tools.get(call.toolCallId) ?? canonicalTool({ ...call, ...(params._meta ? { _meta: params._meta as Record<string, unknown> } : {}) }, hooks);
      // One tool call can need several consent rounds; hos decides per tool call, so later rounds reuse the first answer.
      const earlier = decided.get(call.toolCallId);
      if (earlier) return choose(options, earlier);
      if (hooks.autoAllow?.(params)) return choose(options, 'allow_once');
      const answer = async (): Promise<Outcome> => {
        if (tool.name.startsWith(HOS_TOOL_PREFIX)) return 'allow_once';
        const request = { toolUseId: call.toolCallId, tool: tool.name, input: tool.input, ...(call.title ? { title: call.title } : {}) };
        const refused = sink.refuse(request) ?? (await sink.beforeTool(request));
        if (refused) {
          translate.rejected(call.toolCallId, refused);
          refusals.push(`${tool.name}: ${refused}`);
          return 'reject_once';
        }
        if (!sink.needsDecision(request)) return 'allow_once';
        const decision = await sink.permission(request);
        const denied = deniedMessage(decision);
        if (denied) {
          translate.rejected(call.toolCallId, denied);
          if (decision !== 'deny') refusals.push(`${tool.name}: ${denied}`);
          return 'reject_once';
        }
        return 'allow_once';
      };
      const outcome = await answer();
      decided.set(call.toolCallId, outcome);
      return choose(options, outcome);
    };
    const connect = async (resume: string | undefined, mode: ChatMode | undefined): Promise<Link> => {
      const adopted = resume ? undefined : await this.spare?.take(spec.cwd, spec.env);
      const acp = adopted ?? AcpConnection.spawn(this.command(), spec.cwd, this.env(spec.env));
      let loading = false;
      let replayed = 0;
      const busUp = spec.bus && hooks.serverReady ? hooks.serverReady(acp, HOS_SERVER) : Promise.resolve(true);
      acp.onNotification((method, params) => {
        if (method !== 'session/update') return;
        const update = params.update as AcpUpdate;
        const replay = hooks.replay ? hooks.replay(update) : loading;
        if (replay) replayed += 1;
        const started = update.sessionUpdate === 'tool_call' && update.toolCallId !== undefined && !translate.tools.has(update.toolCallId);
        entries.push(...toTranscript(update, hooks));
        if (replay) {
          if (started) translate.tools.set(update.toolCallId!, canonicalTool(update, hooks));
          return;
        }
        translate.update(update);
        observe(acp, params.sessionId as string, update, started);
      });
      acp.onRequest('session/request_permission', permission);
      try {
        if (!adopted) await acp.request('initialize', INITIALIZE);
        const inputs = {
          cwd: spec.cwd,
          additionalDirectories: [...new Set([...(spec.brainDir && spec.brainDir !== spec.cwd ? [spec.brainDir] : []), ...spec.extraDirs])],
          mcpServers: [
            ...(spec.bus ? [{ type: 'http', name: HOS_SERVER, url: spec.bus.url, headers: [{ name: 'Authorization', value: `Bearer ${spec.bus.token}` }] }] : []),
            ...(spec.mcpServers ?? []).map(({ name, url, headers }) => ({ type: 'http', name, url, headers: Object.entries(headers).map(([key, value]) => ({ name: key, value })) })),
          ],
        };
        let session: SessionResult | undefined;
        if (resume) {
          loading = true;
          session = await acp
            .request<SessionResult>('session/load', { ...inputs, sessionId: resume })
            .then((loaded) => ({ ...loaded, sessionId: resume }), () => undefined)
            .finally(() => {
              loading = false;
            });
          // A load that replays nothing counts as a failed resume, so the chat starts a new session instead.
          if (session && replayed === 0) session = undefined;
        }
        const model = pickedModel(spec.model);
        session ??= await acp.request<SessionResult>('session/new', {
          ...inputs,
          ...(hooks.newSession?.({ ...(model ? { model } : {}), ...(spec.effort ? { effort: spec.effort } : {}), modeId: this.modeFor(mode, undefined) }) ?? {}),
        });
        const sessionId = session.sessionId;
        if (!sessionId) throw new Error(`${this.config.name} returned no sessionId`);
        translate.options(session.configOptions ?? []);
        await this.applyPick(acp, sessionId, spec, translate);
        const wanted = this.modeFor(mode, session.modes);
        if (wanted && wanted !== session.modes?.currentModeId) await acp.request('session/set_mode', { sessionId, modeId: wanted }).catch(() => undefined);
        if (!(await busUp)) console.warn(`hos bus did not connect to the ${this.config.name} chat within ${BUS_CONNECT_MS} ms`);
        this.spare?.refill(spec.cwd, spec.env);
        return { acp, sessionId, modes: session.modes };
      } catch (error) {
        acp.close();
        throw error;
      }
    };
    const link = await connect(spec.resume, spec.mode);
    await announce();
    const agents = spec.brainDir && spec.cwd !== spec.brainDir ? await readFile(join(spec.brainDir, 'AGENTS.md'), 'utf8').catch(() => '') : '';
    const brain = [agents, spec.profileAppend ?? ''].filter(Boolean).join('\n\n');
    const sessionId = link.sessionId;
    this.live.set(sessionId, entries);
    return agentSession(link, sink, translate, [this.config.firstTurnNote ?? '', brain].filter(Boolean).join('\n\n'), entries, refusals, flags, (next) => this.modeFor(next, link.modes), () =>
      this.release(sessionId, entries),
    );
  }

  async transcript(nativeId: string, cwd: string): Promise<TranscriptEntry[]> {
    const known = this.live.get(nativeId) ?? this.recent.get(nativeId);
    if (known) return mergeText(known);
    const acp = AcpConnection.spawn(this.command(), cwd, this.env({}));
    const entries: TranscriptEntry[] = [];
    acp.onNotification((method, params) => {
      if (method === 'session/update') entries.push(...toTranscript(params.update as AcpUpdate, this.hooks));
    });
    try {
      await acp.request('initialize', INITIALIZE);
      await acp.request('session/load', { sessionId: nativeId, cwd, additionalDirectories: [], mcpServers: [] });
    } catch {
      return mergeText(entries);
    } finally {
      acp.close();
    }
    return mergeText(entries);
  }

  async terminalCommand(spec: AgentChatSpec & { resume: string }): Promise<string[]> {
    const terminal = this.config.terminal;
    if (!terminal?.length) throw new Error(`the ${this.config.name} harness has no terminal command, so it has no Take over`);
    return terminal.map((part) => part.replaceAll(SESSION_PLACEHOLDER, spec.resume));
  }

  private async applyPick(acp: AcpConnection, sessionId: string, spec: AgentChatSpec, translate: AcpTranslator): Promise<void> {
    const set = async (configId: string, value: string) => {
      const result = await acp.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', { sessionId, configId, value });
      translate.options(result?.configOptions ?? []);
    };
    const modelOption = this.config.modelOption ?? 'model';
    const model = pickedModel(spec.model);
    const advertised = translate.values(modelOption);
    if (model && advertised.length > 0 && !advertised.includes(model)) throw new Error(`${this.config.name} has no model "${model}"; pick one of ${advertised.join(', ')}`);
    if (model && advertised.length > 0 && translate.value(modelOption) !== model) await set(modelOption, model);
    const effortOption = this.config.effortOption;
    if (effortOption && spec.effort && translate.value(effortOption) !== spec.effort && translate.values(effortOption).includes(spec.effort)) await set(effortOption, spec.effort);
  }

  private modeFor(mode: ChatMode | undefined, modes: SessionResult['modes']): string | undefined {
    const plan = this.config.modes?.plan ?? PLAN_MODE;
    const build = this.config.modes?.build;
    const wanted = mode === 'plan' ? plan : (modes?.currentModeId === plan ? build : modes?.currentModeId) ?? build;
    const available = modes?.availableModes?.map((candidate) => candidate.id) ?? [];
    if (!wanted || available.length === 0 || available.includes(wanted)) return wanted;
    return modes?.currentModeId ?? build;
  }

  private release(sessionId: string, entries: TranscriptEntry[]): void {
    if (this.live.get(sessionId) !== entries) return;
    this.live.delete(sessionId);
    this.recent.set(sessionId, entries);
    for (const stale of [...this.recent.keys()].slice(0, Math.max(0, this.recent.size - RECENT_TRANSCRIPTS))) this.recent.delete(stale);
  }

  private command(): string[] {
    return [this.config.command, ...(this.config.args ?? [])];
  }

  private env(extra: Record<string, string>): Record<string, string> {
    return { ...processEnv(), ...extra, ...(this.config.env ?? {}) };
  }
}

function agentSession(
  link: Link,
  sink: AgentSink,
  translate: AcpTranslator,
  firstContext: string,
  entries: TranscriptEntry[],
  refusals: string[],
  flags: TurnFlags,
  modeFor: (mode: ChatMode) => string | undefined,
  release: () => void,
): AgentSession {
  const { sessionId } = link;
  const queue: string[] = [];
  let running = false;
  let stopped = false;
  let first = true;
  const turn = async (text: string) => {
    sink.event({ type: 'turn.started' });
    entries.push({ kind: 'user', text });
    const context = [first ? firstContext : '', sink.beforeTurn() ?? ''].filter(Boolean).join('\n\n');
    first = false;
    let prompt = [...(context ? [{ type: 'text', text: `${CONTEXT_OPEN}\n${context}\n${CONTEXT_CLOSE}` }] : []), { type: 'text', text }];
    let explained = false;
    refusals.length = 0;
    for (;;) {
      flags.cancelledByHos = false;
      const { stopReason } = await link.acp.request<{ stopReason: string }>('session/prompt', { sessionId, prompt });
      translate.endTurn();
      const refused = refusals.splice(0);
      const settled = stopReason === 'end_turn' || (stopReason === 'cancelled' && flags.cancelledByHos);
      const explain: boolean = settled && refused.length > 0 && !explained;
      explained ||= explain;
      const reason = explain ? refusalNote(refused) : stopReason === 'end_turn' ? sink.beforeStop() : undefined;
      if (reason) {
        prompt = [{ type: 'text', text: reason }];
        continue;
      }
      if (stopReason === 'end_turn' || stopReason === 'cancelled') return sink.event({ type: 'turn.completed' });
      return sink.event({ type: 'error', message: `turn ended with ${stopReason}` });
    }
  };
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length && !stopped) await turn(queue.shift()!);
    } catch (error) {
      if (!stopped) sink.event({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };
  return {
    nativeId: sessionId,
    send(text) {
      queue.push(text);
      void pump();
    },
    setMode: async (next: ChatMode) => {
      const modeId = modeFor(next);
      if (modeId) await link.acp.request('session/set_mode', { sessionId, modeId });
    },
    stop: async () => {
      stopped = true;
      release();
      link.acp.notify('session/cancel', { sessionId });
      link.acp.close();
    },
  };
}

const FALLBACK: Record<Outcome, string> = { allow_once: 'allow_always', reject_once: 'reject_always' };

function choose(options: PermissionOption[], kind: Outcome) {
  const option = options.find((candidate) => candidate.kind === kind) ?? options.find((candidate) => candidate.kind === FALLBACK[kind]);
  if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
  if (kind === 'reject_once') return { outcome: { outcome: 'cancelled' } };
  throw new Error(`the agent offered no ${kind} permission option`);
}

function pickedModel(model: string | undefined): string | undefined {
  return model && model !== AGENT_DEFAULT_MODEL ? model : undefined;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function toTranscript(update: AcpUpdate, hooks: AcpHooks): TranscriptEntry[] {
  if (update.sessionUpdate === 'user_message_chunk') {
    const text = stripContext(update.content?.text ?? '');
    return text ? [{ kind: 'user', text }] : [];
  }
  if (update.sessionUpdate === 'agent_message_chunk') return update.content?.text ? [{ kind: 'assistant', text: update.content.text }] : [];
  if (update.sessionUpdate === 'tool_call' && update.toolCallId) {
    const tool = canonicalTool(update, hooks);
    return [{ kind: 'tool_use', toolUseId: update.toolCallId, name: tool.name, input: tool.input }];
  }
  if (update.sessionUpdate === 'tool_call_update' && update.toolCallId && (update.status === 'completed' || update.status === 'failed')) {
    return [{ kind: 'tool_result', toolUseId: update.toolCallId, output: outputText(update.rawOutput), isError: update.status === 'failed' }];
  }
  return [];
}

function mergeText(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.reduce<TranscriptEntry[]>((merged, entry) => {
    const last = merged.at(-1);
    if (last?.kind === 'assistant' && entry.kind === 'assistant') merged[merged.length - 1] = { kind: 'assistant', text: `${last.text}${entry.text}` };
    else merged.push(entry);
    return merged;
  }, []);
}

function stripContext(text: string): string {
  const end = text.indexOf(CONTEXT_CLOSE);
  return (text.startsWith(CONTEXT_OPEN) && end >= 0 ? text.slice(end + CONTEXT_CLOSE.length) : text).trim();
}

export async function memoryFiles(cwd: string, patterns: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*.md')) {
      const dir = join(cwd, pattern.slice(0, -'/*.md'.length));
      const files = await readdir(dir).catch(() => [] as string[]);
      found.push(...files.filter((file) => file.endsWith('.md')).sort().map((file) => join(dir, file)));
    } else {
      const file = join(cwd, pattern);
      if (await readFile(file, 'utf8').then(() => true, () => false)) found.push(file);
    }
  }
  return found;
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function exitsZero(command: string[], env: Record<string, string>): Promise<boolean> {
  const [bin, ...args] = command;
  return new Promise((resolve) => {
    execFile(bin!, args, { env, timeout: SIGNED_IN_MS }, (error) => resolve(!error));
  });
}
