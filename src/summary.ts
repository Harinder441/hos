import type { EventBody } from './api/types.js';

const SUMMARY_CHARS = 500;

export function summarize(text: string): string {
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
}

export function eventSummary(body: EventBody): string | undefined {
  switch (body.type) {
    case 'message.user':
      return summarize(`user: ${body.text}`);
    case 'message.completed':
      return summarize(`assistant: ${body.text}`);
    case 'tool.started':
      return summarize(`tool ${body.name}: ${body.input}`);
    case 'tool.completed':
      return summarize(`result${body.isError ? ' (error)' : ''}: ${body.output}`);
    case 'chat.error':
      return summarize(`error: ${body.message}`);
    case 'bus.call':
      return summarize(`bus ${body.tool} ${body.outcome}: ${body.input}`);
    default:
      return undefined;
  }
}
