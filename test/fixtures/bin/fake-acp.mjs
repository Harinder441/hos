#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const dir = process.env.FAKE_ACP_DIR ?? join(tmpdir(), 'hos-fake-acp');
mkdirSync(dir, { recursive: true });
const flavour = process.env.FAKE_ACP_FLAVOUR ?? 'plain';
let nextId = 1;
const waiting = new Map();

const log = (entry) => appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ ...entry, argv: process.argv.slice(2), env: process.env.FAKE_ACP_MARK ?? null })}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `agent-${nextId++}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const file = (sessionId) => join(dir, `session-${sessionId}.json`);
const load = (sessionId) => (existsSync(file(sessionId)) ? JSON.parse(readFileSync(file(sessionId), 'utf8')) : null);
const save = (state) => writeFileSync(file(state.sessionId), JSON.stringify(state));
const meta = (extra) => (flavour === 'meta' ? { _meta: { fake: extra } } : {});

function update(state, sessionUpdate, keep = true) {
  if (keep) state.history.push(sessionUpdate);
  send({ method: 'session/update', params: { sessionId: state.sessionId, update: sessionUpdate } });
}

function say(state, text) {
  update(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
}

const SESSION = () => ({
  configOptions: [{ id: 'model', currentValue: 'fast', options: [{ value: 'fast' }, { value: 'smart' }] }],
  modes: { currentModeId: 'code', availableModes: [{ id: 'code' }, { id: 'plan' }] },
});

async function prompt(params) {
  const state = load(params.sessionId);
  const text = params.prompt.map((block) => block.text ?? '').filter((t) => !t.startsWith('<hos-context>')).join('\n');
  state.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
  const asked = /create a file at (\S+)/.exec(text)?.[1];
  if (asked) state.path = asked;
  if (asked || text.startsWith('Try the same Write')) {
    const toolCallId = `call-${randomUUID().slice(0, 8)}`;
    const call = { toolCallId, title: `Write ${basename(state.path)}`, kind: 'edit', status: 'pending', rawInput: { path: state.path, content: 'hi' } };
    update(state, { sessionUpdate: 'tool_call', ...call });
    const answer = await ask('session/request_permission', {
      sessionId: state.sessionId,
      toolCall: call,
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const allowed = answer?.outcome?.optionId === 'yes';
    if (allowed) writeFileSync(state.path, 'hi');
    update(state, { sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed', rawOutput: allowed ? 'File created successfully' : 'rejected' });
    say(state, allowed ? 'Done.' : 'DENIED');
  } else if (/Which file did you create/.test(text)) {
    say(state, state.path ? basename(state.path) : 'none');
  } else {
    if (flavour === 'meta') update(state, { sessionUpdate: 'session_info_update', ...meta({ percent: 10 }) }, false);
    say(state, 'OK');
  }
  update(state, { sessionUpdate: 'usage_update', used: 1234, size: 200000 }, false);
  save(state);
  return { stopReason: 'end_turn' };
}

const handlers = {
  initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } } }),
  'session/new': async (params) => {
    const state = { sessionId: `fake-${randomUUID().slice(0, 8)}`, cwd: params.cwd, history: [], path: null };
    save(state);
    return { sessionId: state.sessionId, ...SESSION() };
  },
  'session/load': async (params) => {
    const state = load(params.sessionId);
    if (!state) return {};
    for (const entry of state.history) send({ method: 'session/update', params: { sessionId: state.sessionId, update: { ...entry, ...meta({ replay: true }) } } });
    return SESSION();
  },
  'session/set_config_option': async (params) => ({ configOptions: [{ id: params.configId, currentValue: params.value, options: [{ value: 'fast' }, { value: 'smart' }] }] }),
  'session/set_mode': async () => ({}),
  'session/prompt': prompt,
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  log({ method: message.method, params: message.params });
  if (message.id === undefined) return;
  const handler = handlers[message.method];
  if (!handler) return send({ id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
  handler(message.params ?? {}).then(
    (result) => send({ id: message.id, result }),
    (error) => send({ id: message.id, error: { code: -32603, message: error.message } }),
  );
});
