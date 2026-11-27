import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

type Params = Record<string, unknown>;
type RequestHandler = (params: Params) => Promise<unknown>;
interface Message {
  id?: number | string;
  method?: string;
  params?: Params;
  result?: unknown;
  error?: { message: string };
}

export class AcpConnection {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly listeners: Array<(method: string, params: Params) => void> = [];
  private exited: Error | undefined;

  private constructor(
    private readonly child: ChildProcess,
    name: string,
  ) {
    createInterface({ input: child.stdout! }).on('line', (line) => this.receive(line));
    child.on('exit', (code, signal) => this.fail(new Error(`${name} exited (${code ?? signal})`)));
    child.on('error', (error) => this.fail(error));
    child.stdin!.on('error', (error) => this.fail(error));
  }

  static spawn(command: string[], cwd: string, env: Record<string, string>): AcpConnection {
    const [bin, ...args] = command;
    return new AcpConnection(spawn(bin!, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] }), [bin, ...args.slice(0, 1)].join(' '));
  }

  get alive(): boolean {
    return !this.exited;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.exited) this.write({ method, params });
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  onNotification(listener: (method: string, params: Params) => void): void {
    this.listeners.push(listener);
  }

  close(): void {
    this.fail(new Error('closed'));
    this.child.kill('SIGTERM');
  }

  private write(message: object): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private receive(line: string): void {
    if (this.exited) return;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return;
    }
    if (message.method === undefined) {
      const waiter = this.pending.get(message.id as number);
      this.pending.delete(message.id as number);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
      return;
    }
    if (message.id === undefined) {
      for (const listener of this.listeners) listener(message.method, message.params ?? {});
      return;
    }
    const handler = this.handlers.get(message.method);
    const id = message.id;
    void (handler ? handler(message.params ?? {}) : Promise.reject(new Error(`no handler for ${message.method}`))).then(
      (result) => this.notifyResult({ id, result: result ?? null }),
      (error: Error) => this.notifyResult({ id, error: { code: -32603, message: error.message } }),
    );
  }

  private notifyResult(message: object): void {
    if (!this.exited) this.write(message);
  }

  private fail(error: Error): void {
    this.exited ??= error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
