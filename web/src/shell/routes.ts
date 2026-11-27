export const OPS_VIEWS = ['servers', 'terminals', 'governor', 'keeper', 'audit', 'actions'] as const;
export type OpsView = (typeof OPS_VIEWS)[number];

export type Route =
  | { page: 'home' }
  | { page: 'new'; prompt: string }
  | { page: 'topic'; topicId: string; chatId?: string; draft?: true }
  | { page: 'diagram'; topicId: string; diagramId: string }
  | { page: 'openDiagram'; diagramId: string }
  | { page: 'chat'; chatId: string }
  | { page: 'settings'; tab?: string }
  | { page: 'snags' }
  | { page: 'topicHistory' }
  | { page: 'diff'; kind: 'workspace' | 'chat'; id: string; ref?: string }
  | { page: 'ops'; view: OpsView }
  | { page: 'terminal'; name: string }
  | { page: 'redirect'; to: string };

export const TOPIC_HISTORY_HREF = '#/topics/history';

const LEGACY: Record<string, string> ={ '#/inbox': '#/', '#/chats': '#/', '#/config': '#/settings/workspaces', '#/schedules': '#/settings/schedules' };
for (const view of OPS_VIEWS) LEGACY[`#/${view}`] = `#/ops/${view}`;

export function parseRoute(hash: string): Route {
  const legacy = LEGACY[hash];
  if (legacy) return { page: 'redirect', to: legacy };
  if (['', '#', '#/'].includes(hash)) return { page: 'home' };
  const [path = '', query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  if (path === '#/new') return { page: 'new', prompt: params.get('prompt') ?? '' };
  if (path === '#/settings') return { page: 'settings' };
  if (path === '#/snags') return { page: 'snags' };
  if (path === TOPIC_HISTORY_HREF) return { page: 'topicHistory' };
  let m = /^#\/settings\/([^/]+)$/.exec(path);
  if (m) return { page: 'settings', tab: decodeURIComponent(m[1]!) };
  m = /^#\/diagram\/([^/]+)$/.exec(path);
  if (m) return { page: 'openDiagram', diagramId: decodeURIComponent(m[1]!) };
  m = /^#\/topic\/([^/]+)\/new$/.exec(path);
  if (m) return { page: 'topic', topicId: decodeURIComponent(m[1]!), draft: true };
  m = /^#\/topic\/([^/]+)\/diagram\/([^/]+)$/.exec(path);
  if (m) return { page: 'diagram', topicId: decodeURIComponent(m[1]!), diagramId: decodeURIComponent(m[2]!) };
  m = /^#\/topic\/([^/]+)(?:\/chat\/([^/]+))?$/.exec(path);
  if (m) return { page: 'topic', topicId: decodeURIComponent(m[1]!), ...(m[2] ? { chatId: decodeURIComponent(m[2]) } : {}) };
  m = /^#\/chat\/([^/]+)$/.exec(path);
  if (m) return { page: 'chat', chatId: decodeURIComponent(m[1]!) };
  m = /^#\/diff\/(workspace|chat)\/([^/]+)$/.exec(path);
  if (m) {
    const ref = params.get('ref');
    return { page: 'diff', kind: m[1] as 'workspace' | 'chat', id: m[2]!, ...(ref ? { ref } : {}) };
  }
  m = /^#\/ops\/([a-z]+)$/.exec(path);
  if (m && (OPS_VIEWS as readonly string[]).includes(m[1]!)) return { page: 'ops', view: m[1] as OpsView };
  m = /^#\/terminal\/(.+)$/.exec(hash);
  if (m) return { page: 'terminal', name: decodeURIComponent(m[1]!) };
  return { page: 'redirect', to: '#/' };
}

export function topicHref(topicId: string, chatId?: string | null): string {
  return `#/topic/${encodeURIComponent(topicId)}${chatId ? `/chat/${encodeURIComponent(chatId)}` : ''}`;
}

export function newChatHref(topicId: string): string {
  return `#/topic/${encodeURIComponent(topicId)}/new`;
}

export function diagramHref(topicId: string, diagramId: string): string {
  return `#/topic/${encodeURIComponent(topicId)}/diagram/${encodeURIComponent(diagramId)}`;
}

export function routeTopicId(route: Route): string | undefined {
  return route.page === 'topic' || route.page === 'diagram' ? route.topicId : undefined;
}
