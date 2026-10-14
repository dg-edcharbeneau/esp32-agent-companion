import type {Readable, Writable} from 'node:stream';

// JSON-RPC 2.0, one message per newline-terminated UTF-8 line, in both directions.
export const maxLineBytes = 4 * 1024 * 1024;

// The JSON-RPC codes, and the ones the plugin API adds.
export const rpcErrors = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  notInitialized: -32001,
  permissionDenied: -32002,
  needsSetup: -32003,
  upstream: -32004,
  busy: -32005,
  cancelled: -32800,
  timeout: -32801,
} as const;

// An error with a short message meant for the user, and optional data meant only for the log.
export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

type Handler = (params: unknown) => unknown;
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RpcPeerOptions {
  // A line that is not JSON. Plugins must not print to stdout; the host counts these.
  onJunk?: (line: string) => void;
  // The stream broke a rule (a line over the size limit). The host restarts the plugin.
  onViolation?: (reason: string) => void;
}

export class RpcPeer {
  readonly #output: Writable;
  readonly #pending = new Map<number, Pending>();
  readonly #requests = new Map<string, Handler>();
  readonly #notifications = new Map<string, Handler>();
  readonly #options: RpcPeerOptions;
  #nextId = 1;
  #buffer = '';
  #closed = false;

  constructor(input: Readable, output: Writable, options: RpcPeerOptions = {}) {
    this.#output = output;
    this.#options = options;
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.#receive(chunk));
    input.on('end', () => this.close(new RpcError(rpcErrors.internal, 'The plugin closed its output.')));
    input.on('error', () => this.close(new RpcError(rpcErrors.internal, 'The plugin output failed.')));
    output.on('error', () => this.close(new RpcError(rpcErrors.internal, 'The plugin input failed.')));
  }

  get closed(): boolean {
    return this.#closed;
  }

  onRequest(method: string, handler: Handler): void {
    this.#requests.set(method, handler);
  }

  onNotification(method: string, handler: Handler): void {
    this.#notifications.set(method, handler);
  }

  request(method: string, params: unknown = {}, timeoutMs = 10_000): Promise<unknown> {
    if (this.#closed) return Promise.reject(new RpcError(rpcErrors.internal, 'The plugin is not running.'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.notify('$/cancelRequest', {id});
        reject(new RpcError(rpcErrors.timeout, `The plugin did not answer ${method} in time.`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, {resolve, reject, timer});
      this.#send({jsonrpc: '2.0', id, method, params});
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.#closed) this.#send({jsonrpc: '2.0', method, params});
  }

  // Rejects every waiting request. Called when the plugin exits or breaks the protocol.
  close(error: Error = new RpcError(rpcErrors.internal, 'The plugin stopped.')): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #send(message: unknown): void {
    try {
      this.#output.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.close();
    }
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const end = this.#buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.#buffer.slice(0, end).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(end + 1);
      if (line.trim()) this.#dispatch(line);
    }
    if (Buffer.byteLength(this.#buffer) > maxLineBytes) {
      this.#buffer = '';
      this.#options.onViolation?.(`A message was larger than ${maxLineBytes} bytes.`);
    }
  }

  #dispatch(line: string): void {
    if (Buffer.byteLength(line) > maxLineBytes) {
      this.#options.onViolation?.(`A message was larger than ${maxLineBytes} bytes.`);
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') throw new Error();
    } catch {
      this.#options.onJunk?.(line);
      return;
    }
    if (typeof message.method === 'string') {
      if ('id' in message) void this.#answer(message.id, message.method, message.params);
      else this.#notifications.get(message.method)?.(message.params);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    const error = message.error as {code?: unknown; message?: unknown; data?: unknown} | undefined;
    if (error) {
      pending.reject(new RpcError(typeof error.code === 'number' ? error.code : rpcErrors.internal,
                                  typeof error.message === 'string' ? error.message.slice(0, 300) : 'The plugin failed.',
                                  error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  async #answer(id: unknown, method: string, params: unknown): Promise<void> {
    const handler = this.#requests.get(method);
    try {
      if (!handler) throw new RpcError(rpcErrors.methodNotFound, `Method not found: ${method}`);
      const result = await handler(params);
      this.#send({jsonrpc: '2.0', id, result: result ?? {}});
    } catch (error) {
      const rpc = error instanceof RpcError ? error
        : new RpcError(rpcErrors.internal, error instanceof Error ? error.message : String(error));
      this.#send({jsonrpc: '2.0', id, error: {code: rpc.code, message: rpc.message}});
    }
  }
}
