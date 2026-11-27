import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { LOGIN_FAILURE } from '../api/types.js';

const LIMIT_REACHED = "Claude's usage limit is reached";

const TURN_STOPS: Record<string, string> = {
  rapid_refill_breaker: 'Claude throttled this account for using the window too fast',
  prompt_too_long: 'the prompt is too long for this model',
  image_error: 'Claude could not read an image in the chat',
  malformed_tool_use_exhausted: 'Claude kept calling a tool with invalid input',
  aborted_streaming: 'the turn was stopped while Claude was replying',
  aborted_tools: 'the turn was stopped while a tool was running',
  stop_hook_prevented: 'a Stop hook refused to let the turn end',
  hook_stopped: 'a hook stopped the turn',
  max_turns: 'the turn hit its model round-trip limit',
  budget_exhausted: 'the turn hit its cost budget',
  turn_setup_failed: 'the turn never started',
};

const RESET_AT = /\|\s*(\d{9,13})\s*$/;

export function turnFailure(message: SDKResultMessage): string {
  const detail = turnDetail(message);
  const reason = message.terminal_reason;
  const limit = turnLimit(message);
  if (limit) return `${LIMIT_REACHED}${limit.resetsAt === null ? '' : resetsText(limit.resetsAt)}`;
  const status = message.subtype === 'success' ? message.api_error_status : undefined;
  const named = TURN_STOPS[reason ?? ''] ?? (LOGIN_FAILURE.test(detail) ? 'Claude login expired' : status ? `Claude's API answered ${status}` : 'the turn failed');
  return detail ? `${named}: ${detail}` : named;
}

export function turnModel(mainLoopModel: string | null, message: SDKResultMessage): string | null {
  return mainLoopModel ?? Object.keys(message.modelUsage ?? {})[0] ?? null;
}

export function turnLimit(message: SDKResultMessage): { resetsAt: number | null } | undefined {
  const detail = turnDetail(message);
  const reason = message.terminal_reason;
  if (reason !== 'blocking_limit' && (reason || !/usage limit reached/i.test(detail))) return undefined;
  const stamp = RESET_AT.exec(detail)?.[1];
  return { resetsAt: stamp ? Number(stamp) * (stamp.length > 10 ? 1 : 1000) : null };
}

function turnDetail(message: SDKResultMessage): string {
  return (message.subtype === 'success' ? message.result : message.errors.join('; ')).trim();
}

function resetsText(at: number): string {
  return ` · the window resets at ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(at))}`;
}
