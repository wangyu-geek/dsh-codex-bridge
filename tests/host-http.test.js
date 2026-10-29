import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { apply, createRequestHandler } from '../src/plugin.js';
import { MAX_RESPONSE_BYTES } from '../src/protocol.js';

const token = 'a'.repeat(64);

async function httpFixture(t, controller) {
  const server = createServer(createRequestHandler(controller, token));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const endpoint = `http://127.0.0.1:${server.address().port}/codex-bridge/v1`;
  return (body = {}, headers = {}) => fetch(endpoint, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers,
  }, body: JSON.stringify(body) });
}

test('HTTP authentication and browser-origin denial happen before any runtime operation', async t => {
  let calls = 0;
  const call = await httpFixture(t, { execute: async () => { calls++; return {}; } });
  assert.equal((await call({}, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call({}, { origin: 'https://example.test' })).status, 403);
  assert.equal((await call({}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(calls, 0);
  const response = await call({ operation: 'capabilities' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, data: {} });
  assert.equal(calls, 1);
});

test('HTTP body and complete response byte bounds are enforced', async t => {
  let calls = 0;
  const call = await httpFixture(t, { execute: async () => { calls++; return { text: '中'.repeat(MAX_RESPONSE_BYTES) }; } });
  const oversized = await call({ text: 'x'.repeat(300_000) });
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);
  const response = await call({});
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'response-too-large');
});

test('DSH plugin publishes protected discovery and releases its route and file on unload', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-host-plugin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let route;
  let removed = false;
  const cleanup = [];
  let observed = 0;
  let registered;
  const ctx = {
    sessionProjections: { register: async definition => { registered = definition; } },
    webServer: { getOrigin: () => 'http://127.0.0.1:3080', register: value => {
      route = value;
      return () => { removed = true; };
    } },
    on: () => { observed++; },
    effect: factory => { cleanup.push(factory()); },
    logger: { warn() {} },
  };
  await apply(ctx, { discoveryDirectory: directory, allowControl: false });
  assert.equal(registered.key, 'codexBridgeStatus');
  assert.ok(observed > 0);
  assert.equal(route.path, '/codex-bridge/v1');
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const descriptor = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
  assert.equal(files[0], `${descriptor.instanceId}.json`);
  assert.equal(descriptor.readOnly, true);
  assert.equal(descriptor.token.length, 64);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600);
  await Promise.all(cleanup.map(dispose => dispose()));
  assert.equal(removed, true);
  assert.deepEqual(await readdir(directory), []);
});
