import type { APIRoute } from 'astro';
import { orderedDocs, slugOf } from '../llms';

export const GET: APIRoute = async () => {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  const lines = (await orderedDocs()).map(
    (d) => `- [${d.data.title}](${base}docs/${slugOf(d)}.md): ${d.data.description ?? ''}`,
  );
  const body = [
    '# hos',
    '',
    '> A small server on your own computer that runs your coding agents as a team: topics, helper chats, tasks and locks, approvals, and a brain (a git repo you own) that holds their rules, skills and progress. One web app for the computer and the phone.',
    '',
    `Every page is plain Markdown at the link below. All pages in one file: ${base}llms-full.txt`,
    '',
    '## Docs',
    '',
    ...lines,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
