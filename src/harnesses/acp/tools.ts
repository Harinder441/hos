import { TOOL, type CanonicalTool } from '../tools.js';
import type { AcpHooks, AcpToolCall } from './config.js';

const PURPOSE_KEYS = ['__tool_use_purpose', '__toolUsePurpose'];

export function rawInput(call: AcpToolCall): Record<string, unknown> {
  const raw = call.rawInput && typeof call.rawInput === 'object' ? { ...(call.rawInput as Record<string, unknown>) } : {};
  for (const key of PURPOSE_KEYS) delete raw[key];
  return raw;
}

export function canonicalTool(call: AcpToolCall, hooks: AcpHooks = {}): CanonicalTool {
  return hooks.tool?.(call) ?? byKind(call);
}

// ACP tool kinds (read, edit, delete, move, search, execute, think, fetch, other) map onto hos's names; delete and move keep a name hos does not classify, so they ask.
export function byKind(call: AcpToolCall): CanonicalTool {
  const raw = rawInput(call);
  if (call.kind === 'execute') return shell(raw);
  if (call.kind === 'read') return { name: TOOL.read, input: { file_path: filePath(raw), ...raw } };
  if (call.kind === 'edit') return writeOrEdit(raw);
  if (call.kind === 'fetch') return { name: TOOL.webFetch, input: { url: raw.url, ...raw } };
  if (call.kind === 'search' && /web/i.test(call.title ?? '')) return { name: TOOL.webSearch, input: { query: raw.query, ...raw } };
  if (call.kind === 'search') return raw.pattern !== undefined || raw.query !== undefined ? { name: TOOL.grep, input: { pattern: raw.pattern ?? raw.query, ...raw } } : { name: TOOL.glob, input: raw };
  if (call.kind === 'delete') return { name: 'Delete', input: { file_path: filePath(raw), ...raw } };
  if (call.kind === 'move') return { name: 'Move', input: raw };
  return { name: call.title || 'unknown', input: raw };
}

export function shell(raw: Record<string, unknown>): CanonicalTool {
  return { name: TOOL.bash, input: { command: raw.command ?? raw.cmd, ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}) } };
}

export function writeOrEdit(raw: Record<string, unknown>): CanonicalTool {
  const created = raw.command === 'create' || ((raw.text !== undefined || raw.content !== undefined) && raw.oldStr === undefined && raw.newStr === undefined && raw.old_string === undefined);
  const content = raw.text ?? raw.content;
  return created ? { name: TOOL.write, input: { file_path: filePath(raw), content } } : { name: TOOL.edit, input: { file_path: filePath(raw), ...raw } };
}

export function filePath(raw: Record<string, unknown>): unknown {
  return raw.path ?? raw.file_path ?? raw.abs_path ?? (raw.operations as Array<{ path?: string }> | undefined)?.[0]?.path;
}
