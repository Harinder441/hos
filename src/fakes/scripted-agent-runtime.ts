import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  deniedMessage,
  type AgentChatSpec,
  type AgentRuntime,
  type AgentSession,
  type AgentSink,
} from '../adapters/agent-runtime.js';
import { sleep, type Clock } from '../adapters/clock.js';
import type { ContextSlice, TranscriptEntry, WindowReadings } from '../api/types.js';
import type { Named } from '../naming.js';
import { parseProgress, sectionRev } from '../work.js';
import { callBus } from './bus-client.js';

export type ScriptStep =
  | { afterMs?: number; delta: string }
  | { afterMs?: number; fail: string; limit?: { resetsAt: number | null } }
  | { afterMs?: number; think: string }
  | { afterMs?: number; tokens: number }
  | { afterMs?: number; spend: number }
  | { afterMs?: number; credits: number }
  | { afterMs?: number; limit: { window: 'five_hour' | 'seven_day'; pct: number; resetsAt?: number } }
  | { afterMs?: number; compact: number }
  | { afterMs?: number; breakdown: ContextSlice[] }
  | {
      afterMs?: number;
      tool: string;
      input: Record<string, unknown>;
      output: string;
      ask?: boolean;
      writes?: { path: string; content: string };
      run?: string;
    }
  | { afterMs?: number; bus: string; args?: Record<string, unknown> }
  | { afterMs?: number; subagent: ScriptedSubagent }
  | { afterMs?: number; shell: { taskId: string; description: string; done?: boolean } };

export interface ScriptedSubagent {
  type?: string;
  description: string;
  prompt: string;
  tools: Array<{ afterMs?: number; tool: string; input: Record<string, unknown>; output: string }>;
  result: string;
  resume?: string;
  background?: boolean;
}

export interface TurnInfo {
  context: string | undefined;
  cwd: string;
  extraDirs: string[];
  workDir?: string;
}

export type AgentScript = (input: string, history: readonly TranscriptEntry[], turn: TurnInfo) => ScriptStep[];

const ECHO_QUESTION = {
  question: 'Which way should I go?',
  header: 'Direction',
  options: [
    { label: 'Left', description: 'the short way' },
    { label: 'Right', description: 'the scenic way' },
  ],
  multiSelect: false,
};

const ECHO_CHECKS = {
  question: 'Which checks should run on save?',
  header: 'Checks',
  options: [
    { label: 'Lint', description: 'eslint' },
    { label: 'Types', description: 'tsc', preview: 'tsc --noEmit -p tsconfig.json' },
    { label: 'Tests', description: 'vitest' },
  ],
  multiSelect: true,
};

export const echoScript: AgentScript = (input, _history, turn) => {
  const workspace = turn.extraDirs[0];
  const spawn = /^spawn (worker|reviewer|scout) (.+)$/.exec(input);
  if (spawn) {
    const [, role, intent] = spawn;
    return [{ bus: 'spawn', args: { role, intent, prompt: intent, client_request_id: randomUUID() } }, { delta: `Spawned a ${role}.` }];
  }
  const writer = /^spawn writer (\S+) (.+)$/.exec(input);
  if (writer) {
    const [, file, intent] = writer;
    return [{ bus: 'spawn', args: { role: 'worker', intent, prompt: intent, files_owned: [file], client_request_id: randomUUID() } }, { delta: 'Spawned a writer.' }];
  }
  const think = /^think (.+)$/.exec(input)?.[1];
  if (think) return [{ think: '' }, { think: `Thinking about ${think}.` }, { delta: `Thought about ${think}.` }];
  const choose = /^choose (\S+) (.+)$/.exec(input);
  if (choose) return [{ bus: 'workspace_choose', args: { repo: choose[1], why: choose[2] } }, { delta: `Asked which ${choose[1]} checkout.` }];
  const task = /^task (.+)$/.exec(input)?.[1];
  if (task) return [{ bus: 'task_create', args: { title: task } }, { delta: `Task added: ${task}` }];
  const claim = /^claim (T\d+)$/.exec(input)?.[1];
  if (claim) return [{ bus: 'task_claim', args: { task: claim } }, { delta: `Claimed ${claim}.` }];
  const lock = /^lock (\S+)$/.exec(input)?.[1];
  if (lock) return [{ bus: 'lock', args: { paths: [lock] } }, { delta: `Locked ${lock}.` }];
  const url = /^read (https?:\/\/\S+)$/.exec(input)?.[1];
  if (url) return [{ tool: 'WebFetch', input: { url }, output: `page at ${url}` }, { delta: `Read ${url}.` }];
  const plan = /^plan (.+)$/.exec(input)?.[1];
  if (plan) return [{ delta: `Plan: ${plan}` }, { bus: 'propose_plan', args: { title: plan } }];
  const background = /^background subagent (.+)$/.exec(input)?.[1];
  if (background) {
    const tools = [{ afterMs: 4000, tool: 'Read', input: { file_path: 'README.md' }, output: '# readme' }];
    return [{ subagent: { type: 'Explore', description: background, prompt: `Find ${background}.`, tools, result: `Found ${background}.`, background: true } }, { delta: 'Subagent started.' }];
  }
  const subagent = /^subagent (.+)$/.exec(input)?.[1];
  if (subagent) {
    const tools = [
      { afterMs: 700, tool: 'Read', input: { file_path: 'README.md' }, output: '# readme' },
      { afterMs: 700, tool: 'Grep', input: { pattern: subagent }, output: 'README.md:1' },
    ];
    return [{ subagent: { type: 'Explore', description: subagent, prompt: `Find ${subagent} and report back.`, tools, result: `Found ${subagent} in README.md.` } }, { delta: 'Subagent done.' }];
  }
  const resumed = /^resume (.+)$/.exec(input)?.[1];
  if (resumed) {
    const tools = [
      { afterMs: 700, tool: 'Read', input: { file_path: 'README.md' }, output: '# readme' },
      { afterMs: 700, tool: 'Edit', input: { file_path: 'README.md' }, output: 'edited' },
    ];
    const resume = { resume: 'agent-1', type: 'general-purpose', description: resumed, prompt: `Continue ${resumed} where you stopped.`, tools, result: `Finished ${resumed}.` };
    return [{ subagent: resume }, { delta: 'Resumed.' }];
  }
  const canvas = /^canvas (create|update|read) (\{[\s\S]+\})$/.exec(input);
  if (canvas) return [{ bus: `canvas_${canvas[1]}`, args: JSON.parse(canvas[2]!) }, { delta: `Canvas ${canvas[1]} sent.` }];
  const draw = /^draw (\S+) (\[[\s\S]+\])$/.exec(input);
  if (draw) return [{ bus: 'diagram_apply', args: { id: draw[1], ops: JSON.parse(draw[2]!) } }, { delta: 'Drew it.' }];
  const shot = /^shot (\S+)$/.exec(input)?.[1];
  if (shot) return [{ bus: 'diagram_screenshot', args: { id: shot } }, { delta: 'Took a screenshot.' }];
  const mermaid = /^mermaid (\S+) ([\s\S]+)$/.exec(input);
  if (mermaid) return [{ bus: 'diagram_import_mermaid', args: { id: mermaid[1], mermaid: mermaid[2] } }, { delta: 'Imported it.' }];
  const card = /^card (.+)$/.exec(input)?.[1];
  if (card) return [{ bus: 'update_card', args: { text: card } }, { delta: 'Card updated.' }];
  if (input === 'ask') {
    return [{ tool: 'AskUserQuestion', input: { questions: [ECHO_QUESTION] }, output: '', ask: true }, { delta: 'Thanks.' }];
  }
  if (input === 'ask more') {
    return [{ tool: 'AskUserQuestion', input: { questions: [ECHO_QUESTION, ECHO_CHECKS] }, output: '', ask: true }, { delta: 'Thanks.' }];
  }
  if (input === 'fail') return [{ fail: 'scripted failure' }];
  if (input === 'fail login') return [{ fail: 'Claude login expired: Failed to authenticate: OAuth session expired and could not be refreshed' }];
  const spend = /^spend (\d+)$/.exec(input)?.[1];
  if (spend) return [{ spend: Number(spend) }, { delta: `Spent ${spend} tokens.` }];
  if (input === 'park') {
    const args = { question: 'Which schema version?', options: ['v1', 'v2'], recommendation: 'v2, because v1 is deprecated' };
    return [{ bus: 'ask', args }, { delta: 'Parked until the user answers.' }];
  }
  const commit = /^commit (.+)$/.exec(input)?.[1];
  if (commit) {
    const run = `${workspace ? `cd ${JSON.stringify(workspace)} && ` : ''}git add -A && git -c user.name=hos-scripted -c user.email=scripted@hos.invalid commit -qm ${JSON.stringify(commit)}`;
    return [{ tool: 'Bash', input: { command: run }, output: '', run }, { delta: `Committed: ${commit}` }];
  }
  const limit = /^limit (five_hour|seven_day) (\d+)$/.exec(input);
  if (limit) return [{ limit: { window: limit[1] as 'five_hour' | 'seven_day', pct: Number(limit[2]), resetsAt: Date.now() + 2 * 3_600_000 } }, { delta: 'Usage noted.' }];
  if (input === 'briefing') return [{ delta: turn.context || 'No briefing this turn.' }];
  if (input.startsWith('[hos] Context refresh:') && turn.workDir) return refreshSteps(turn.cwd, turn.workDir);
  if (input.startsWith('[hos] Your context was refreshed.')) return [{ delta: 'Hi, the context is fresh.' }];
  const note = /^note ([\w.-]+)$/.exec(input)?.[1];
  const name = /^write ([\w.-]+)$/.exec(input)?.[1] ?? note;
  const file = name && workspace && !note ? join(workspace, name) : name;
  const content = 'hello from hos\n';
  const write: ScriptStep[] = file
    ? [{ tool: 'Write', input: { file_path: file, content }, output: `Wrote ${name}`, ask: true, writes: { path: file, content } }]
    : [];
  const tokens = /^context (\d+)$/.exec(input)?.[1];
  const grow: ScriptStep[] = tokens ? [{ tokens: Number(tokens) }] : [];
  if (input === 'breakdown') grow.push({ tokens: 38_000 }, { breakdown: ECHO_BREAKDOWN });
  return [...write, ...grow, ...`Echo: ${input}`.split(/(?<= )/).map((delta) => ({ afterMs: 40, delta }))];
};

function refreshSteps(cwd: string, workDir: string): ScriptStep[] {
  const branch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  const sections = { Goal: 'Lead this topic.', State: 'Nothing running.', Where: `- Path: \`${cwd}\`\n- Branch: \`${branch}\``, Open: 'none', 'Next step': 'Greet the user.' };
  const file = join(workDir, 'PROGRESS.md');
  const current = existsSync(file) ? parseProgress(readFileSync(file, 'utf8')).sections : [];
  const revs = Object.fromEntries(current.filter((section) => section.name in sections).map((section) => [section.name, sectionRev(section.body)]));
  return [{ afterMs: 1500, delta: 'Updating PROGRESS.md. ' }, { bus: 'progress_update', args: { sections, revs, note: 'context refresh' } }, { bus: 'refresh_ready' }, { delta: 'Refreshing.' }];
}

const ECHO_BREAKDOWN: ContextSlice[] = [
  { name: 'System prompt', tokens: 3_000 },
  { name: 'System tools', tokens: 10_000 },
  { name: 'Skills', tokens: 12_000 },
  { name: 'Memory files', tokens: 7_000 },
  { name: 'Messages', tokens: 6_000 },
];

const BACKGROUND_LAUNCHED = 'Async agent launched successfully.';

const TERMINAL_SCRIPT = [
  'printf "scripted session %s\\n" "$1"',
  'while printf "> " && IFS= read -r line; do printf "Echo: %s\\n" "$line"; printf "%s\\n" "$line" >> "$2"; done',
].join('; ');

export class ScriptedAgentRuntime implements AgentRuntime {
  readonly started: Array<AgentChatSpec & { nativeId: string }> = [];
  readonly stopped: string[] = [];
  windows: WindowReadings | undefined;
  private readonly transcripts = new Map<string, TranscriptEntry[]>();
  private readonly terminalLogs = join(tmpdir(), 'hos-scripted-terminals');
  private readonly tokens = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly script: AgentScript = echoScript,
    readonly agent = 'scripted',
  ) {}

  async start(spec: AgentChatSpec, sink: AgentSink): Promise<AgentSession> {
    const nativeId = spec.resume ?? `scripted-${randomUUID()}`;
    this.started.push({ ...spec, nativeId });
    const transcript = this.transcripts.get(nativeId) ?? [];
    this.transcripts.set(nativeId, transcript);
    await this.absorbTerminalTurns(nativeId);
    if (spec.brainDir) sink.event({ type: 'context.loaded', ...(await brainContext(spec.brainDir)) });
    let turns = Promise.resolve();
    let stopped = false;
    const runTurn = async (firstInput: string) => {
      if (stopped) return;
      const context = sink.beforeTurn();
      sink.event({ type: 'turn.started' });
      const messageId = randomUUID();
      let text = '';
      let spent = 0;
      for (let input: string | undefined = firstInput; input !== undefined; input = sink.beforeStop()) {
        const steps = this.script(input, [...transcript], { context, cwd: spec.cwd, extraDirs: spec.extraDirs, workDir: spec.env.WORK_DIR });
        transcript.push({ kind: 'user', text: input });
        if (!(await runSteps(steps, messageId, (delta) => (text += delta), (tokens) => (spent += tokens)))) return;
      }
      transcript.push({ kind: 'assistant', text });
      sink.event({ type: 'message.completed', messageId, text });
      if (spent) sink.event({ type: 'tokens.used', model: spec.model ?? null, input: spent, output: 0, cacheRead: 0, cacheCreation: 0 });
      sink.event({ type: 'context.usage', tokens: this.tokens.get(nativeId) ?? 0, compactAt: spec.compactAt });
      sink.event({ type: 'turn.completed' });
    };
    const runSteps = async (
      steps: ScriptStep[],
      messageId: string,
      say: (delta: string) => void,
      spend: (tokens: number) => void,
    ): Promise<boolean> => {
      for (const step of steps) {
        if (step.afterMs) await sleep(this.clock, step.afterMs);
        if (stopped) return false;
        if ('compact' in step) {
          if (!sink.beforeCompact()) {
            this.tokens.set(nativeId, step.compact);
            sink.event({ type: 'context.compacted' });
          }
          continue;
        }
        if ('breakdown' in step) {
          sink.event({ type: 'context.breakdown', categories: step.breakdown });
          continue;
        }
        if ('bus' in step) {
          const toolUseId = randomUUID();
          const name = `mcp__hos__${step.bus}`;
          const input = step.args ?? {};
          transcript.push({ kind: 'tool_use', toolUseId, name, input });
          sink.event({ type: 'tool.started', toolUseId, name, input });
          const { output, isError } = await callBus(spec.bus, step.bus, input);
          if (stopped) return false;
          transcript.push({ kind: 'tool_result', toolUseId, output, isError });
          sink.event({ type: 'tool.completed', toolUseId, output, isError });
          continue;
        }
        if ('subagent' in step) {
          const { type, description, prompt, tools, result, resume, background } = step.subagent;
          const toolUseId = randomUUID();
          const name = resume ? 'SendMessage' : 'Agent';
          const input = resume
            ? { to: resume, message: prompt }
            : { description, prompt, ...(type ? { subagent_type: type } : {}), ...(background ? { run_in_background: true } : {}) };
          transcript.push({ kind: 'tool_use', toolUseId, name, input });
          sink.event({ type: 'tool.started', toolUseId, name, input });
          const request = { toolUseId, tool: name, input };
          const refused = sink.refuse(request) ?? (await sink.beforeTool(request));
          if (stopped) return false;
          if (refused) {
            transcript.push({ kind: 'tool_result', toolUseId, output: refused, isError: true });
            sink.event({ type: 'tool.completed', toolUseId, output: refused, isError: true });
            continue;
          }
          sink.event({ type: 'subagent.started', toolUseId, description, agentType: type ?? null, depth: 1, prompt });
          if (resume) {
            transcript.push({ kind: 'tool_result', toolUseId, output: 'Message queued for delivery.', isError: false });
            sink.event({ type: 'tool.completed', toolUseId, output: 'Message queued for delivery.', isError: false });
          }
          const begun = this.clock.now();
          const usage = (done: number) => ({ tokens: done * 1_000, tools: done, durationMs: this.clock.now() - begun });
          const runChildren = async (): Promise<boolean> => {
            for (const [index, child] of tools.entries()) {
              if (child.afterMs) await sleep(this.clock, child.afterMs);
              if (stopped) return false;
              const childId = randomUUID();
              sink.event({ type: 'tool.started', toolUseId: childId, name: child.tool, input: child.input, parentToolUseId: toolUseId });
              sink.event({ type: 'tool.completed', toolUseId: childId, output: child.output, isError: false, parentToolUseId: toolUseId });
              sink.event({ type: 'subagent.progress', toolUseId, ...usage(index + 1), lastTool: child.tool });
            }
            sink.event({ type: 'subagent.finished', toolUseId, status: 'completed', summary: result, ...usage(tools.length) });
            return true;
          };
          if (background) {
            transcript.push({ kind: 'tool_result', toolUseId, output: BACKGROUND_LAUNCHED, isError: false });
            sink.event({ type: 'tool.completed', toolUseId, output: BACKGROUND_LAUNCHED, isError: false });
            void runChildren();
            continue;
          }
          if (!(await runChildren())) return false;
          if (resume) continue;
          transcript.push({ kind: 'tool_result', toolUseId, output: result, isError: false });
          sink.event({ type: 'tool.completed', toolUseId, output: result, isError: false });
          continue;
        }
        if ('fail' in step) {
          sink.event({ type: 'error', message: step.fail, ...(step.limit ? { limit: step.limit } : {}) });
          return false;
        }
        if ('think' in step) {
          const thinkingId = randomUUID();
          if (step.think) sink.event({ type: 'thinking.delta', thinkingId, text: step.think });
          sink.event({ type: 'thinking.completed', thinkingId, text: step.think });
          continue;
        }
        if ('tokens' in step) {
          this.tokens.set(nativeId, step.tokens);
          continue;
        }
        if ('spend' in step) {
          spend(step.spend);
          continue;
        }
        if ('shell' in step) {
          sink.event({ type: 'shell.started', taskId: step.shell.taskId, description: step.shell.description });
          if (step.shell.done) sink.event({ type: 'shell.finished', taskId: step.shell.taskId });
          continue;
        }
        if ('credits' in step) {
          sink.event({ type: 'credits.used', credits: step.credits });
          continue;
        }
        if ('limit' in step) {
          sink.event({ type: 'provider.limit', window: step.limit.window, pct: step.limit.pct, resetsAt: step.limit.resetsAt ?? null });
          continue;
        }
        if ('tool' in step) {
          const toolUseId = randomUUID();
          transcript.push({ kind: 'tool_use', toolUseId, name: step.tool, input: step.input });
          sink.event({ type: 'tool.started', toolUseId, name: step.tool, input: step.input });
          const request = { toolUseId, tool: step.tool, input: step.input };
          const refused = sink.refuse(request) ?? (await sink.beforeTool(request));
          if (stopped) return false;
          const decision = refused ? 'deny' : step.ask || sink.needsDecision(request) ? await sink.permission(request) : 'approve';
          if (stopped) return false;
          const denial = deniedMessage(decision);
          const denied = denial !== undefined;
          if (!denied && step.writes) {
            const file = resolve(spec.cwd, step.writes.path);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, step.writes.content);
          }
          const ran = !denied && step.run ? await runCommand(spec, step.run) : undefined;
          const output =
            refused ?? denial ?? (typeof decision === 'object' && 'answers' in decision ? JSON.stringify(decision.answers) : step.output || ran?.output || '');
          const isError = denied || Boolean(ran && ran.code !== 0);
          transcript.push({ kind: 'tool_result', toolUseId, output, isError });
          sink.event({ type: 'tool.completed', toolUseId, output, isError });
          continue;
        }
        say(step.delta);
        sink.event({ type: 'message.delta', messageId, text: step.delta });
      }
      return true;
    };
    return {
      nativeId,
      send(text) {
        turns = turns.then(() => runTurn(text));
      },
      stop: async () => {
        stopped = true;
        this.stopped.push(nativeId);
      },
    };
  }

  async usage(): Promise<WindowReadings | undefined> {
    return this.windows;
  }

  titles = async (text: string, _areas: string[] = []): Promise<string | Named | null> => {
    const name = /\bname it (.+)$/im.exec(text)?.[1]?.trim();
    if (!name) return null;
    await new Promise((done) => setTimeout(done, 1_200));
    return name;
  };

  async title(text: string, areas: string[]): Promise<Named | null> {
    const named = await this.titles(text, areas);
    return typeof named === 'string' ? { title: named, area: null } : named;
  }

  async transcript(nativeId: string): Promise<TranscriptEntry[]> {
    await this.absorbTerminalTurns(nativeId);
    return [...(this.transcripts.get(nativeId) ?? [])];
  }

  async terminalCommand(spec: AgentChatSpec & { resume: string }): Promise<string[]> {
    await mkdir(this.terminalLogs, { recursive: true });
    return ['sh', '-c', TERMINAL_SCRIPT, 'scripted', spec.resume, this.terminalLog(spec.resume)];
  }

  loginCommand(): string[] {
    return ['sh', '-c', 'echo "scripted login: press Enter"; read line'];
  }

  private terminalLog(nativeId: string): string {
    return join(this.terminalLogs, `${nativeId}.log`);
  }

  private async absorbTerminalTurns(nativeId: string): Promise<void> {
    const file = this.terminalLog(nativeId);
    const lines = await readFile(file, 'utf8').then((text) => text.split('\n').filter(Boolean), () => []);
    if (!lines.length) return;
    await rm(file, { force: true });
    const transcript = this.transcripts.get(nativeId) ?? [];
    this.transcripts.set(nativeId, transcript);
    for (const text of lines) transcript.push({ kind: 'user', text }, { kind: 'assistant', text: `Echo: ${text}` });
  }
}

function runCommand(spec: AgentChatSpec, command: string): Promise<{ code: number; output: string }> {
  const argv = ['sh', '-c', command];
  const child = spawn(argv[0]!, argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env } });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk));
  return new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function brainContext(brainDir: string): Promise<{ memoryFiles: string[]; skills: string[] }> {
  const claudeMd = join(brainDir, 'CLAUDE.md');
  const hasClaudeMd = await access(claudeMd).then(() => true, () => false);
  const skills = await readdir(join(brainDir, '.claude/skills'), { withFileTypes: true }).catch(() => []);
  return {
    memoryFiles: hasClaudeMd ? [claudeMd] : [],
    skills: skills.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
  };
}
