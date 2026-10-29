/** Real Loader/Web composition with a deterministic local model; never touches the user's DSH home. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const project = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(process.env.DSH_SOURCE || join(project, '..', 'deepseek-harness'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read, predicate, timeout = 20_000) {
  const until = Date.now() + timeout;
  let value;
  while (Date.now() < until) {
    value = await read();
    if (predicate(value)) return value;
    await pause(30);
  }
  throw new Error(`State did not settle: ${JSON.stringify(value)}`);
}

test('real Web runtime: cold-safe reads, prompt deduplication, completion, cancellation, and unload', { timeout: 100_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-bridge-'));
  const home = join(root, '.dsh');
  const registry = join(home, 'bridges', 'instances');
  const fixture = join(root, 'fixture.mjs');
  const overlay = join(root, 'bridge.patch.yml');
  const readyPath = join(root, 'ready');
  const llm = pathToFileURL(join(repo, 'packages/llm/llm/src/index.ts')).href;
  await writeFile(fixture, `
import { writeFile } from 'node:fs/promises';
import { LlmAdapter, createUserMessage } from ${JSON.stringify(llm)};
export const name = 'codex-bridge-integration-fixture';
export const inject = ['llm','agents','appReady','appExit'];
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id:model, name:model }; }
  async *stream(options) {
    const text = options.messages.filter(m => m.role === 'user')
      .flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text))
      .findLast(text => ['one','HOLD','cold seed'].includes(text)) || 'missing instruction';
    if (text.includes('HOLD')) {
      await new Promise((resolve,reject) => {
        if (options.signal.aborted) { reject(options.signal.reason); return; }
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true});
      });
    }
    const reply = 'BRIDGE_ECHO: ' + text;
    yield {type:'block-start', index:0, blockType:'text'};
    yield {type:'text-delta', index:0, text:reply};
    yield {type:'block-end', index:0, block:{type:'text',text:reply}};
    yield {type:'usage',usage:{inputTokens:2,outputTokens:3}};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}
export function apply(ctx, config) {
  ctx.llm.registerAdapter(['bridge-fixture'], new Adapter());
  ctx.effect(() => ctx.appReady.onReady(() => {
    void (async () => {
      const args = id => ({sessionId:id,agentOptions:{provider:'bridge-fixture',model:'test'},meta:{cwd:config.root}});
      const live = await ctx.agents.create(args('bridge-smoke'));
      const cold = await ctx.agents.create(args('bridge-smoke-cold'));
      cold.agent.followup(createUserMessage({content:[{type:'text',text:'cold seed'}],source:{kind:'user'}}));
      await cold.agent.whenIdle();
      await cold.dispose();
      await writeFile(config.ready,'ready');
    })().catch(error => { console.error(error); ctx.appExit(1); });
  }));
}
`);
  await writeFile(overlay, [
    '- id: hmr', '  disabled: true',
    '- id: session-title-llm', '  disabled: true',
    '- insert:',
    `    - name: ${JSON.stringify(pathToFileURL(join(project, 'src/plugin.js')).href)}`,
    `      config: ${JSON.stringify({ allowControl: true, discoveryDirectory: registry })}`,
    `    - name: ${JSON.stringify(pathToFileURL(fixture).href)}`,
    `      config: ${JSON.stringify({ root, ready: readyPath })}`,
    '',
  ].join('\n'));
  const require = createRequire(join(repo, 'package.json'));
  const child = spawn(process.execPath, [
    '--import', require.resolve('tsx/esm'), join(repo, 'apps/cli/src/bin.ts'),
    '--profile', 'web', '--patch', overlay, '--no-open', '--port', '0',
  ], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(root, '.agents'),
      DSH_BRIDGE_DIR: registry, DSH_TELEMETRY_DISABLED: '1', TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json') },
  });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    logs = (logs + String(chunk)).slice(-16_384);
  });
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({code,signal}); }));
  let mcp;
  try {
    await eventually(async () => {
      if (exited) throw new Error(`DSH exited: ${logs.replace(/token=[^\s&]+/g, 'token=[redacted]')}`);
      try { return await readFile(readyPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }, value => value === 'ready', 60_000);
    const files = await readdir(registry);
    assert.equal(files.filter(f => f.endsWith('.json')).length, 1);
    const descriptorPath = join(registry, files.find(f => f.endsWith('.json')));
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
    mcp = new Client({name:'real-dsh-acceptance',version:'1.0.0'});
    await mcp.connect(new StdioClientTransport({command:process.execPath,args:[join(project,'bin/mcp.js')],
      env:{...process.env,DSH_BRIDGE_DIR:registry},stderr:'pipe'}));
    const tool = async (name, args = {}) => {
      const result = await mcp.callTool({name,arguments:args});
      assert.notEqual(result.isError,true,JSON.stringify(result));
      assert.equal(JSON.stringify(result).includes(descriptor.token),false);
      return result.structuredContent;
    };
    assert.equal((await tool('dsh_instances')).instances[0].online,true);
    assert.equal((await mcp.listTools()).tools.length,8);
    const call = async (operation, args = {}) => {
      const response = await fetch(descriptor.endpoint, { method: 'POST',
        headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({operation,...args}), signal: AbortSignal.timeout(15_000) });
      const envelope = await response.json();
      assert.equal(envelope.ok, true, JSON.stringify(envelope));
      return envelope.data;
    };
    const capabilities = await call('capabilities');
    assert.ok(capabilities);
    const sessions = await call('sessions');
    assert.match(JSON.stringify(sessions), /bridge-smoke/);
    const cold = await call('status', {sessionId:'bridge-smoke-cold'});
    assert.equal(cold.attached, false, JSON.stringify(cold));
    await call('read', {sessionId:'bridge-smoke-cold'});
    assert.equal((await call('status', {sessionId:'bridge-smoke-cold'})).attached, false);

    const before = await call('status', {sessionId:'bridge-smoke'});
    await tool('dsh_send', {sessionId:'bridge-smoke',requestId:'integration-one',text:'one',mode:'queue'});
    const completed = await eventually(() => call('status', {sessionId:'bridge-smoke'}),
      value => value.lastEnd?.reason?.kind === 'completed' && !value.running);
    const transcript = await call('read', {sessionId:'bridge-smoke'});
    assert.match(JSON.stringify(transcript), /BRIDGE_ECHO: one/);
    assert.ok(transcript.records.some(record => record.role === 'user' && record.text === 'one'), 'latest-turn includes the human prompt');
    const recent=(await tool('dsh_recent',{workspace:root,limit:5,timeZone:'Asia/Shanghai'})).data;
    assert.equal(recent.source,'dsh-runtime');
    const continued=recent.sessions.find(row=>row.sessionId==='bridge-smoke');
    assert.equal(continued.lastTurn,1);
    assert.match(continued.lastReply.text,/BRIDGE_ECHO: one/);
    assert.ok(continued.lastConversationTime);
    await call('send', {sessionId:'bridge-smoke',requestId:'integration-one',text:'one',mode:'queue'});
    const same = await call('status', {sessionId:'bridge-smoke'});
    assert.equal(same.lastTurn, completed.lastTurn, 'retry must not create a new turn');
    assert.notEqual(same.cursor, before.cursor);

    await call('send', {sessionId:'bridge-smoke',requestId:'integration-hold',text:'HOLD',mode:'queue'});
    const running = await eventually(() => call('status', {sessionId:'bridge-smoke'}), value => value.running === true);
    const waiting = call('wait', {sessionId:'bridge-smoke',cursor:running.cursor,timeoutMs:5_000});
    await tool('dsh_interrupt', {sessionId:'bridge-smoke'});
    assert.ok(await waiting);
    const stopped = await eventually(() => call('status', {sessionId:'bridge-smoke'}),
      value => value.lastEnd?.reason?.kind === 'aborted' && !value.running);
    assert.equal(stopped.running, false);
    child.kill('SIGTERM');
    const ended = await exit;
    assert.equal(ended.code, 0, logs.replace(/token=[^\s&]+/g, 'token=[redacted]'));
    assert.deepEqual((await readdir(registry)).filter(f => f.endsWith('.json')), [], 'unload must remove discovery');
  } finally {
    await mcp?.close();
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([exit, pause(5_000)]);
      if (!exited) { child.kill('SIGKILL'); await exit; }
    }
    await rm(root, { recursive:true, force:true });
  }
});
