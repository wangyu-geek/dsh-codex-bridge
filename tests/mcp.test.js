import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ROUTE } from '../src/protocol.js';

async function fixture(t, { holdWait = false, largeReply = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-mcp-'));
  await chmod(directory, 0o700);
  const calls = [];
  const token = 'mcp-fixture-secret-which-never-reaches-model';
  let markWaitStarted;
  let markWaitClosed;
  const waitStarted = new Promise(resolve => { markWaitStarted = resolve; });
  const waitClosed = new Promise(resolve => { markWaitClosed = resolve; });
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (holdWait && body.operation === 'wait') {
      response.once('close', markWaitClosed);
      markWaitStarted();
      return;
    }
    response.setHeader('content-type', 'application/json');
    const data = body.operation === 'capabilities' ? { operations: ['sessions', 'read', 'send', 'interrupt', 'wait'] }
      : body.operation === 'sessions' ? { sessions: [{ sessionId: 'existing', title: 'Existing session', running: false }] }
        : body.operation === 'send' ? { accepted: true, requestId: body.requestId }
          : body.operation === 'interrupt' ? { accepted: true, queuePreserved: true }
            : { running: false, lastEnd: { kind: 'completed' }, lastReply: largeReply ? 'x'.repeat(260 * 1024) : 'Result is ready.' };
    response.end(JSON.stringify({ ok: true, data }));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  await writeFile(join(directory, 'test-instance.json'), JSON.stringify({ schemaVersion: 1, instanceId: 'test-instance',
    endpoint: `http://127.0.0.1:${http.address().port}${ROUTE}`, token, pid: process.pid,
    startedAt: Date.now(), profile: 'test', readOnly: false }), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('bin/mcp.js')],
    env: { ...process.env, DSH_BRIDGE_DIR: directory }, stderr: 'pipe' });
  const client = new Client({ name: 'bridge-integration-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    await client.close();
    http.closeAllConnections();
    await new Promise(done => http.close(done));
    await rm(directory, { recursive: true, force: true });
    assert.equal(stderr.includes(token), false);
  });
  await client.connect(transport);
  return { client, calls, token, waitStarted, waitClosed };
}

test('real stdio MCP handshake exposes recent conversations and control tools', async t => {
  const { client } = await fixture(t);
  const result = await client.listTools();
  assert.deepEqual(result.tools.map(item => item.name).sort(), [
    'dsh_instances', 'dsh_interrupt', 'dsh_read', 'dsh_recent', 'dsh_send', 'dsh_sessions', 'dsh_status', 'dsh_wait',
  ]);
  assert.equal(result.tools.find(item => item.name === 'dsh_read').annotations.readOnlyHint, true);
  assert.equal(result.tools.find(item => item.name === 'dsh_send').annotations.readOnlyHint, false);
  assert.equal(result.tools.find(item => item.name === 'dsh_interrupt').annotations.destructiveHint, true);
});

test('recent DSH conversations use a workspace filter on the live bridge', async t => {
  const {client,calls}=await fixture(t);
  await client.callTool({name:'dsh_recent',arguments:{workspace:'code-agents',limit:5,timeZone:'Asia/Shanghai'}});
  assert.deepEqual(calls.at(-1),{operation:'recent',workspace:'code-agents',limit:5,timeZone:'Asia/Shanghai'});
  const tools=await client.listTools();
  assert.equal(tools.tools.find(tool=>tool.name==='dsh_recent').annotations.readOnlyHint,true);
});

test('real stdio discovery and session queries keep credentials out of both result forms', async t => {
  const { client, token } = await fixture(t);
  const instances = await client.callTool({ name: 'dsh_instances', arguments: {} });
  assert.equal(instances.structuredContent.instances[0].online, true);
  const sessions = await client.callTool({ name: 'dsh_sessions', arguments: { instanceId: 'test-instance' } });
  assert.equal(sessions.structuredContent.data.sessions[0].sessionId, 'existing');
  assert.equal(JSON.stringify([instances, sessions]).includes(token), false);
});

test('real stdio sends and interrupts an explicitly selected session with stable request identity', async t => {
  const { client, calls } = await fixture(t);
  const sent = await client.callTool({ name: 'dsh_send', arguments: {
    instanceId: 'test-instance', sessionId: 'existing', requestId: 'stable-send-1', text: 'Continue the authorized task.',
  } });
  assert.equal(sent.structuredContent.data.accepted, true);
  assert.equal(calls.at(-1).requestId, 'stable-send-1');
  assert.equal(calls.at(-1).mode, 'queue');
  const stopped = await client.callTool({ name: 'dsh_interrupt', arguments: { sessionId: 'existing' } });
  assert.equal(stopped.structuredContent.data.queuePreserved, true);
});

test('real stdio forwards the session-list offset for older pages', async t => {
  const { client, calls } = await fixture(t);
  await client.callTool({ name: 'dsh_sessions', arguments: { instanceId: 'test-instance', limit: 25, offset: 100 } });
  assert.deepEqual(calls.at(-1), { limit: 25, offset: 100, operation: 'sessions' });
});

test('tool schema rejects a send without requestId before reaching DSH', async t => {
  const { client, calls } = await fixture(t);
  try {
    const result = await client.callTool({ name: 'dsh_send', arguments: { sessionId: 'existing', text: 'Work.' } });
    assert.equal(result.isError, true);
  } catch (error) {
    assert.match(String(error), /requestId|validation|required/i);
  }
  assert.equal(calls.length, 0);
});

test('status output preserves separate idle and completed-turn facts', async t => {
  const { client } = await fixture(t);
  const result = await client.callTool({ name: 'dsh_status', arguments: { sessionId: 'existing' } });
  assert.equal(result.structuredContent.data.running, false);
  assert.equal(result.structuredContent.data.lastEnd.kind, 'completed');
});

test('complete MCP result bounds include both text and structured copies', async t => {
  const { client } = await fixture(t, { largeReply: true });
  const result = await client.callTool({ name: 'dsh_read', arguments: { sessionId: 'existing' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'OUTPUT_TOO_LARGE');
  assert.equal(Buffer.byteLength(JSON.stringify(result)) < 1024, true);
});

test('MCP request cancellation reaches the pending HTTP wait', async t => {
  const { client, waitStarted, waitClosed } = await fixture(t, { holdWait: true });
  const controller = new AbortController();
  const pending = client.callTool({ name: 'dsh_wait', arguments: { sessionId: 'existing', timeoutMs: 45_000 } }, { signal: controller.signal });
  await waitStarted;
  controller.abort();
  await assert.rejects(pending);
  let timer;
  try {
    await Promise.race([waitClosed, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Cancellation did not close the wait request')), 2000); })]);
  } finally { clearTimeout(timer); }
});
