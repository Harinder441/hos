import { getCollection, type CollectionEntry } from 'astro:content';
import { PAGES } from './order.mjs';

export async function orderedDocs(): Promise<CollectionEntry<'docs'>[]> {
  const docs = await getCollection('docs');
  const bySlug = new Map(docs.map((d) => [d.id.replace(/^docs\//, ''), d]));
  return PAGES.map((p) => bySlug.get(p.slug)).filter((d): d is CollectionEntry<'docs'> => !!d);
}

export function pageMarkdown(entry: CollectionEntry<'docs'>): string {
  const body = (entry.body ?? '')
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\n/gm, '')
    .replace(/[ \t]*<!--[\s\S]*?-->/g, '')
    .replace(/^<a id="[^"]*"><\/a>\n+/gm, '')
    .replace(/^<summary>(.*)<\/summary>$/gm, '**$1**')
    .replace(/^<\/?details>\n/gm, '')
    .replace(/&lt;/g, '<')
    .trim();
  return `# ${entry.data.title}\n\n> ${entry.data.description ?? ''}\n\n${body}\n`;
}

export function slugOf(entry: CollectionEntry<'docs'>): string {
  return entry.id.replace(/^docs\//, '');
}
