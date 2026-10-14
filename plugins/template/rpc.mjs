// Agent Buddy plugin protocol: JSON-RPC 2.0, one message per line, on stdin and stdout.
// Copy this file into your plugin unchanged. It has no dependencies.
import {createInterface} from 'node:readline';

export const errors = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  notInitialized: -32001,
  permissionDenied: -32002,
  needsSetup: -32003,
  upstream: -32004,
  busy: -32005,
  cancelled: -32800,
};

// Throw this from a method to send a specific error code. The message is shown to the user,
// so keep it short and never include secrets.
export class PluginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Starts the plugin. `methods` answer the host's requests; `notifications` receive its notifications.
// Each gets (params, host). Returns the host handle: request, notify, log and status.
export function startPlugin({methods = {}, notifications = {}, input = process.stdin, output = process.stdout,
                             exit = code => process.exit(code)} = {}) {
  const send = message => output.write(`${JSON.stringify(message)}\n`);
  const pending = new Map();
  let nextId = 1;
  const host = {
    request(method, params = {}, timeoutMs = 10_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new PluginError(errors.internal, `The host did not answer ${method}.`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, {resolve, reject, timer});
        send({jsonrpc: '2.0', id, method, params});
      });
    },
    notify(method, params = {}) {
      send({jsonrpc: '2.0', method, params});
    },
    // Goes to the Agent Buddy log. Never log settings or secrets.
    log(level, message) {
      host.notify('host/log', {level, message});
    },
    // Tells the Plugins tab whether the plugin is ready, needs setup, or failed.
    status(state, message) {
      host.notify('host/status', message ? {state, message} : {state});
    },
  };

  const answer = async message => {
    const builtIn = {
      '$/ping': () => ({}),
      shutdown: () => ({}),
    };
    const handler = methods[message.method] ?? builtIn[message.method];
    try {
      if (!handler) throw new PluginError(errors.methodNotFound, `Method not found: ${message.method}`);
      send({jsonrpc: '2.0', id: message.id, result: (await handler(message.params ?? {}, host)) ?? {}});
    } catch (error) {
      send({jsonrpc: '2.0', id: message.id, error: {
        code: error instanceof PluginError ? error.code : errors.internal,
        message: error instanceof Error ? error.message : String(error),
      }});
    }
  };

  const lines = createInterface({input, crlfDelay: Infinity});
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === undefined) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new PluginError(message.error.code, message.error.message));
      else waiting.resolve(message.result);
    } else if (message.id !== undefined) {
      void answer(message);
    } else if (message.method === 'exit') {
      exit(0);
    } else {
      notifications[message.method]?.(message.params ?? {}, host);
    }
  });
  // The host closed stdin: it stopped or crashed. Always exit, so no plugin outlives the companion.
  lines.on('close', () => exit(0));
  return host;
}
