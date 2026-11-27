import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Listener {
  pid: number;
  command: string;
  ports: number[];
}

export async function tcpListeners(): Promise<Listener[]> {
  const stdout = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { maxBuffer: 16 * 1024 * 1024 }).then(
    (result) => result.stdout,
    (error: { stdout?: string }) => error.stdout ?? '',
  );
  const byPid = new Map<number, Listener>();
  let current: Listener | undefined;
  for (const line of stdout.split('\n')) {
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      const pid = Number(value);
      current = byPid.get(pid) ?? { pid, command: '', ports: [] };
      byPid.set(pid, current);
    } else if (field === 'c' && current) {
      current.command = value;
    } else if (field === 'n' && current) {
      const port = Number(value.slice(value.lastIndexOf(':') + 1));
      if (Number.isInteger(port) && !current.ports.includes(port)) current.ports.push(port);
    }
  }
  return [...byPid.values()].map((l) => ({ ...l, ports: l.ports.sort((a, b) => a - b) }));
}

export async function processChildren(): Promise<Map<number, number[]>> {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid='], { maxBuffer: 16 * 1024 * 1024 });
  const children = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  return children;
}

export function descendants(root: number, children: Map<number, number[]>): Set<number> {
  const found = new Set<number>([root]);
  const stack = [root];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      stack.push(child);
    }
  }
  return found;
}
