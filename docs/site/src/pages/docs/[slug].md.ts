import type { APIRoute, GetStaticPaths } from 'astro';
import type { CollectionEntry } from 'astro:content';
import { orderedDocs, pageMarkdown, slugOf } from '../../llms';

export const getStaticPaths = (async () =>
  (await orderedDocs()).map((entry) => ({ params: { slug: slugOf(entry) }, props: { entry } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(pageMarkdown(props.entry as CollectionEntry<'docs'>), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
