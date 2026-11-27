import { HosError } from '../core.js';
import { RawBody, type Handler } from '../http.js';
import type { Snags } from './snags.js';
import type { NewSnag, SnagFilter } from './types.js';

const FILTERS: SnagFilter[] = ['open', 'resolved', 'all'];

export function snagRoutes(snags: Snags): Array<[string, RegExp, Handler]> {
  const ref = (params: string[]) => decodeURIComponent(params[0]!);
  return [
    ['GET', /^\/api\/snags\/summary$/, async () => snags.summary()],
    [
      'GET',
      /^\/api\/snags$/,
      async (_, __, ___, { query }) => {
        const filter = (query.get('state') ?? 'all') as SnagFilter;
        if (!FILTERS.includes(filter)) throw new HosError(400, `state must be one of ${FILTERS.join(', ')}`);
        return snags.list(filter);
      },
    ],
    ['POST', /^\/api\/snags$/, (body) => snags.add(body as unknown as NewSnag, 'you')],
    ['GET', /^\/api\/snags\/([^/]+)$/, async (_, params) => snags.get(ref(params))],
    ['POST', /^\/api\/snags\/([^/]+)\/resolve$/, async (body, params) => snags.resolve(ref(params), 'you', typeof body.note === 'string' ? body.note : undefined)],
    ['POST', /^\/api\/snags\/([^/]+)\/edit$/, async (body, params) => snags.edit(ref(params), body.text as string)],
    ['POST', /^\/api\/snags\/([^/]+)\/comment$/, async (body, params) => snags.comment(ref(params), body.text as string, 'user')],
    ['POST', /^\/api\/snags\/([^/]+)\/reopen$/, async (_, params) => snags.reopen(ref(params))],
    ['POST', /^\/api\/snags\/([^/]+)\/delete$/, (_, params) => snags.remove(ref(params))],
    ['POST', /^\/api\/snags\/([^/]+)\/topic$/, (_, params) => snags.startTopic(ref(params))],
    [
      'POST',
      /^\/api\/snags\/([^/]+)\/chat$/,
      (body, params) => {
        if (typeof body.topicId !== 'string' || !body.topicId) throw new HosError(400, 'topicId is required');
        return snags.chatInTopic(ref(params), body.topicId);
      },
    ],
    [
      'GET',
      /^\/api\/snags\/([^/]+)\/files\/([^/]+)$/,
      async (_, params) => {
        const file = await snags.file(ref(params), decodeURIComponent(params[1]!));
        return new RawBody(file.type, file.data);
      },
    ],
  ];
}
