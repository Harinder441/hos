import type { APIRoute } from 'astro';
import { orderedDocs, pageMarkdown } from '../llms';

export const GET: APIRoute = async () => {
  const body = (await orderedDocs()).map(pageMarkdown).join('\n---\n\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
