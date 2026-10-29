import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { BridgeClient } from '../src/client.js';
import { MAX_RESPONSE_BYTES, ROUTE } from '../src/protocol.js';

const TOKEN = 'secret-token-that-must-not-appear-in-a-tool-result';

async function fixture(t, handler = (_body, response) => response.end(JSON.stringify({ ok: true, data: { running: false } }))) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-client-'));
  await chmod(directory, 0o700);
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ headers: request.headers, body });
    response.setHeader('content-type', 'application/json');
    await handler(body, response, request);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}${ROUTE}`;
  async function descriptor(instanceId = 'instance-one', overrides = {}) {
    const data = { schemaVersion: 1, instanceId, endpoint, token: TOKEN, pid: process.pid, startedAt: Date.now(), profile: 'test', readOnly: false, ...overrides };
    await writeFile(join(directory, `${instanceId}.json`), JSON.stringify(data), { mode: 0o600 });
    return data;
  }
  await descriptor();
  return { client: new BridgeClient({ directory }), directory, calls, descriptor, endpoint };
}

test('discovers an authenticated instance without returning its token', async t => {
  const { client, calls } = await fixture(t, (_body, response) => response.end(JSON.stringify({ ok: true, data: { token: TOKEN, label: TOKEN, operations: ['read'] } })));
  const result = await client.instances();
  assert.equal(result.instances[0].online, true);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(result.instances[0].capabilities.label, '[redacted]');
});

test('requires explicit selection when two discovered instances are online', async t => {
  const { client, descriptor, calls } = await fixture(t);
  await descriptor('instance-two');
  await assert.rejects(client.request('send', { sessionId: 's1', text: 'work', requestId: 'r1' }), { code: 'AMBIGUOUS_INSTANCE' });
  assert.equal(calls.every(call => call.body.operation === 'capabilities'), true);
  const result = await client.request('status', { instanceId: 'instance-two', sessionId: 's1' });
  assert.equal(result.instanceId, 'instance-two');
});

test('rejects remote endpoints and symlink descriptors before sending credentials', async t => {
  const { client, descriptor, directory, calls } = await fixture(t);
  await descriptor('instance-one', { endpoint: `http://example.com${ROUTE}` });
  await symlink(join(directory, 'instance-one.json'), join(directory, 'linked.json'));
  const result = await client.instances();
  assert.equal(result.instances.length, 0);
  assert.equal(result.invalid.length, 2);
  assert.equal(calls.length, 0);
});

test('refuses credentials readable by other users', async t => {
  const { client, directory, calls } = await fixture(t);
  await chmod(join(directory, 'instance-one.json'), 0o644);
  const result = await client.instances();
  assert.equal(result.invalid[0].error.code, 'INSECURE_DISCOVERY');
  assert.equal(calls.length, 0);
});

test('forwards the same caller requestId without retries after a lost send response', async t => {
  const { client, calls } = await fixture(t, (_body, _response, request) => request.socket.destroy());
  const args = { sessionId: 's1', text: 'work', requestId: 'same-request', mode: 'queue' };
  await assert.rejects(client.request('send', args), { code: 'WRITE_OUTCOME_UNKNOWN' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { ...args, operation: 'send' });
});

test('rejects control of a read-only instance without a request', async t => {
  const { client, descriptor, calls } = await fixture(t);
  await descriptor('instance-one', { readOnly: true });
  await assert.rejects(client.request('interrupt', { sessionId: 's1' }), { code: 'READ_ONLY' });
  assert.equal(calls.length, 0);
});

test('bounds chunked server responses even without Content-Length', async t => {
  const { client } = await fixture(t, (_body, response) => {
    response.write('{"ok":true,"data":"');
    response.end('x'.repeat(MAX_RESPONSE_BYTES + 1) + '"}');
  });
  await assert.rejects(client.request('read', { sessionId: 's1' }), { code: 'RESPONSE_TOO_LARGE' });
});

test('does not follow HTTP redirects carrying credentials', async t => {
  const { client, calls } = await fixture(t, (_body, response) => {
    response.writeHead(302, { location: 'http://example.com/' }).end();
  });
  await assert.rejects(client.request('status', { sessionId: 's1' }), { code: 'INSTANCE_OFFLINE' });
  assert.equal(calls.length, 1);
});

test('reports stale/offline instances and missing discovery without pretending completion', async t => {
  const { directory, descriptor } = await fixture(t);
  await descriptor('instance-one', { endpoint: `http://127.0.0.1:1${ROUTE}` });
  const client = new BridgeClient({ directory, requestTimeoutMs: 200 });
  const result = await client.instances();
  assert.equal(result.instances[0].online, false);
  assert.equal(result.instances[0].error.code, 'INSTANCE_OFFLINE');
  const missing = new BridgeClient({ directory: join(directory, 'missing') });
  assert.deepEqual(await missing.instances(), { instances: [], invalid: [] });
});

test('passes cancellation through to a waiting HTTP request', async t => {
  const { client, calls } = await fixture(t, () => {});
  const controller = new AbortController();
  const pending = client.request('wait', { sessionId: 's1', timeoutMs: 45_000 }, { signal: controller.signal });
  while (calls.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});
