const DOCK_EVENT = 'hos:dock';

const dockKey = (topicId: string) => `hos.dock.${topicId}`;

export function readDockTabs(topicId: string): string[] {
  try {
    const open = (JSON.parse(localStorage.getItem(dockKey(topicId)) ?? '{}') as { open?: unknown }).open;
    return Array.isArray(open) ? open.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

export function writeDockTabs(topicId: string, open: string[]): void {
  localStorage.setItem(dockKey(topicId), JSON.stringify({ open }));
}

export function dockTerminal(topicId: string, name: string): void {
  const open = readDockTabs(topicId).filter((tab) => tab !== name);
  writeDockTabs(topicId, [...open, name]);
  dispatchEvent(new CustomEvent(DOCK_EVENT, { detail: { topicId, name } }));
}

export function onDockTerminal(listener: (topicId: string, name: string) => void): () => void {
  const handle = (e: Event) => {
    const { topicId, name } = (e as CustomEvent<{ topicId: string; name: string }>).detail;
    listener(topicId, name);
  };
  addEventListener(DOCK_EVENT, handle);
  return () => removeEventListener(DOCK_EVENT, handle);
}
