import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {RpcError, RpcPeer, rpcErrors} from '../src/plugin-rpc.js';

// Two peers wired back to back, like the host and a plugin.
function pair(options: ConstructorParameters<typeof RpcPeer>[2] = {}) {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return {host: new RpcPeer(bToA, aToB, options), plugin: new RpcPeer(aToB, bToA), toHost: bToA};
}

test('matches requests to responses in both directions', async () => {
  const {host, plugin} = pair();
  plugin.onRequest('add', params => (params as {a: number; b: number}).a + (params as {a: number; b: number}).b);
  host.onRequest('host/getStatus', () => ({state: 'idle'}));
  assert.equal(await host.request('add', {a: 2, b: 3}), 5);
  assert.deepEqual(await plugin.request('host/getStatus'), {state: 'idle'});
});

test('delivers notifications and turns thrown errors into JSON-RPC errors', async () => {
  const {host, plugin} = pair();
  const seen: unknown[] = [];
  host.onNotification('host/log', params => seen.push(params));
  plugin.notify('host/log', {message: 'hi'});
  plugin.onRequest('fails', () => {
    throw new RpcError(rpcErrors.needsSetup, 'Add an API key.');
  });
  await assert.rejects(host.request('fails'), (error: RpcError) =>
    error.code === rpcErrors.needsSetup && error.message === 'Add an API key.');
  await assert.rejects(host.request('missing'), (error: RpcError) => error.code === rpcErrors.methodNotFound);
  assert.deepEqual(seen, [{message: 'hi'}]);
});

test('times out, tells the other side to cancel, and rejects waiting requests on close', async () => {
  const {host, plugin} = pair();
  const cancelled: unknown[] = [];
  plugin.onRequest('slow', () => new Promise(() => undefined));
  plugin.onNotification('$/cancelRequest', params => cancelled.push(params));
  await assert.rejects(host.request('slow', {}, 20), (error: RpcError) => error.code === rpcErrors.timeout);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cancelled, [{id: 1}]);
  const waiting = host.request('slow', {}, 10_000);
  host.close();
  await assert.rejects(waiting, /stopped/);
  await assert.rejects(host.request('slow'), /not running/);
});

test('reports text that is not JSON-RPC and oversized messages', async () => {
  const junk: string[] = [];
  const violations: string[] = [];
  const {toHost} = pair({onJunk: line => junk.push(line), onViolation: reason => violations.push(reason)});
  toHost.write('hello from console.log\n{"not":"rpc"}\n');
  toHost.write(`${'x'.repeat(4 * 1024 * 1024 + 1)}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(junk, ['hello from console.log', '{"not":"rpc"}']);
  assert.equal(violations.length, 1);
});
