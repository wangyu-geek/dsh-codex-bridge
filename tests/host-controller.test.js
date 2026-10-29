import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HostController } from '../src/host-controller.js';
import { initialSessionState } from '../src/session-state.js';

function fixture({ live = true, allowControl = true } = {}) {
  const emitter = new EventEmitter();
  const session = { id: 's1', seq: 11, header: { cwd: '/tmp/work' } };
  const state = { ...initialSessionState(), lastTurn: 1,
    lastEnd: { turn: 1, seq: 10, time: 100, reason: { kind: 'completed' } },
    lastReply: { turn: 1, seq: 9, time: 99, text: 'done', truncated: false } };
  const values = { title: 'Example', codexBridgeStatus: state,
    turnBoundary: { lastTurn: 1, openTurnStartSeq: null }, inbox: { 'next-turn': [], 'next-step': [] } };
  const snapshot = () => ({ asOfSeq: session.seq - 1, values });
  const agent = { id: session.id, session, status: 'idle' };
  const agents = live ? [agent] : [];
  const ctx = {
    on: (event, callback) => emitter.on(event, callback),
    agents: { get: id => agents.find(candidate => candidate.id === id), list: () => agents },
    sessions: { get: id => live && id === session.id ? session : undefined },
    sessionProjections: { snapshot },
    sessionController: {
      projections: async () => ({ kind: 'sequenced', ...snapshot() }),
      list: async () => ({ items: [{ sessionId: 's1', agentAvailable: live, running: false, updatedAt: 100,
        cwd: '/tmp/work', projections: { kind: live ? 'sequenced' : 'cached', ...snapshot() } }] }),
      page: async () => ({ records: [
        { event: { type: 'request/header', seq: 0, data: { token: 'secret' } } },
        { event: { type: 'turn/start', seq: 1, time: 90, data: { turn: 1 } } },
        { event: { type: 'user/message', seq: 2, time: 91, data: {
          role: 'user', content: [{ type: 'text', text: 'user instruction' }], source: { kind: 'user', rpcId: 'r1' },
        } } },
        { event: { type: 'user/message', seq: 3, time: 92, data: {
          role: 'user', content: [{ type: 'text', text: 'secret runtime injection' }], source: { kind: 'runtime-context' },
        } } },
        { event: { type: 'assistant/message', seq: 9, time: 99, data: { turn: 1, message: { content: [
          { type: 'reasoning', text: 'secret thoughts' }, { type: 'text', text: 'visible' },
        ] } } } },
      ], hasMore: false }),
      prompt: async () => ({ accepted: true }), cancel: () => ({ accepted: true }),
    },
  };
  const controller = new HostController(ctx, { instanceId: 'instance1', startedAt: 1, allowControl });
  controller.observe();
  return { ctx, controller, emitter, session, state, values, agents, agent };
}

const signal = () => new AbortController().signal;

test('recent conversations include old sessions continued today, filtered before pagination', async () => {
  const f=fixture();
  const now=Date.UTC(2026,9,29,12);
  const row=(sessionId,cwd,updatedAt,extra={})=>({sessionId,cwd,updatedAt,agentAvailable:false,
    projections:{kind:'sequenced',asOfSeq:10,values:{title:sessionId}},...extra});
  f.ctx.sessionController.list=async()=>({items:[
    row('newer-creation','/work/code-agents',now-1000,{createdAt:now-1000}),
    row('old-continued','/work/code-agents',now,{createdAt:now-7*86400000}),
    row('new-fork-old-prompt','/work/code-agents',now+5000,{projections:{values:{title:'fork',sessionListMetadata:{lastPromptAt:now-86400000}}}}),
    row('unrelated','/work/another-project',now+1000),
    row('subagent','/work/code-agents',now+2000,{parentSessionId:'old-continued',origin:'subagent'}),
    row('blank','/work/code-agents',now+3000,{blank:true}),
  ]});
  f.controller.status=async sessionId=>({lastTurn:14,activity:'idle',runtimeState:'unknown',
    lastEnd:{time:now+60_000,reason:{kind:'completed'}},
    lastReply:{turn:14,time:now+60_000,text:'today result'},artifacts:[{path:'/work/report.md'}],
    source:'stored',asOfSeq:42,goalCompletion:'not-evaluated'});
  const result=await f.controller.execute({operation:'recent',workspace:'code-agents',limit:1,timeZone:'Asia/Shanghai'},signal());
  assert.equal(result.source,'dsh-runtime');
  assert.equal(result.total,3);
  assert.equal(result.sessions[0].sessionId,'old-continued');
  assert.equal(result.sessions[0].lastConversationTime,'2026-10-29 20:00:00');
  assert.equal(result.sessions[0].lastReply.timeText,'2026-10-29 20:01:00');
  assert.equal(result.sessions[0].lastReply.text,'today result');
  assert.equal(result.nextOffset,1);
  const next=await f.controller.execute({operation:'recent',workspace:'/work/code-agents',offset:1,limit:1},signal());
  assert.equal(next.sessions[0].sessionId,'newer-creation');
  const fork=await f.controller.execute({operation:'recent',workspace:'code-agents',offset:2,limit:1},signal());
  assert.equal(fork.sessions[0].sessionId,'new-fork-old-prompt');
  assert.equal(fork.sessions[0].lastConversationAt,now-86400000);
  assert.equal(fork.sessions[0].conversationTimeBasis,'last-user-message');
  const query=await f.controller.execute({operation:'recent',query:'continued'},signal());
  assert.equal(query.sessions.length,1);
});

test('recent result failures stay explicit, invalid zones are rejected and previews are bounded', async () => {
  const f=fixture();
  await assert.rejects(f.controller.recent({timeZone:'bad zone'},signal()),{code:'invalid-request'});
  f.controller.status=async()=>{throw new Error('unavailable')};
  const unavailable=await f.controller.recent({},signal());
  assert.equal(unavailable.sessions[0].resultError.code,'RESULT_UNAVAILABLE');
  assert.equal(unavailable.sessions[0].lastReply,undefined);
  f.controller.status=async()=>({lastReply:{text:'文'.repeat(2000),time:1},source:'stored'});
  const bounded=await f.controller.recent({},signal());
  assert.equal(bounded.sessions[0].lastReply.truncated,true);
  assert.ok(Buffer.byteLength(bounded.sessions[0].lastReply.text)<=1600);
});

test('session pagination reaches older sessions beyond the first hundred', async () => {
  const f = fixture();
  f.ctx.sessionController.list = async () => ({ items: Array.from({length:105}, (_, index) => ({
    sessionId:`session-${index}`, agentAvailable:false, running:false, updatedAt:index,
  })) });
  const page = await f.controller.execute({operation:'sessions',limit:3,offset:100},signal());
  assert.deepEqual(page.sessions.map(row => row.sessionId),['session-100','session-101','session-102']);
  assert.equal(page.nextOffset,103);
  assert.equal(page.hasMore,true);
  const last = await f.controller.execute({operation:'sessions',limit:3,offset:page.nextOffset},signal());
  assert.equal(last.sessions.length,2);
  assert.equal(last.nextOffset,null);
  assert.equal(last.hasMore,false);
  await assert.rejects(f.controller.execute({operation:'sessions',offset:-1},signal()),{code:'invalid-request'});
});

test('idle, round completed and goal completion remain separate with progressing descendants', async () => {
  const f = fixture();
  f.agents.push({ id: 'child', status: 'idle', session: { header: { parentSession: 's1' } } });
  f.agents.push({ id: 'grandchild', status: 'running', session: { header: { parentSession: 'child' } } });
  const status = await f.controller.execute({ operation: 'status', sessionId: 's1' }, signal());
  assert.equal(status.running, false);
  assert.equal(status.lastEnd.reason.kind, 'completed');
  assert.equal(status.goalCompletion, 'not-evaluated');
  assert.equal(status.quiescent, false);
  assert.equal(status.children.length, 2);
});

test('stored session reports unknown runtime and does not activate an Agent', async () => {
  const f = fixture({ live: false });
  f.ctx.sessionController.resolveAgent = () => { throw new Error('Must not activate'); };
  f.ctx.sessionController.follow = () => { throw new Error('Must not activate'); };
  const status = await f.controller.status('s1', signal());
  assert.equal(status.runtimeState, 'unknown');
  assert.equal(status.running, null);
  assert.equal(status.source, 'stored');
  const read = await f.controller.read({ sessionId: 's1' }, signal());
  assert.equal(read.records.find(record => record.role === 'assistant').text, 'visible');
  const user = read.records.find(record => record.role === 'user');
  assert.equal(user.text, 'user instruction');
  assert.equal(user.turn, 1);
  assert.equal(user.requestId, 'r1');
  assert.equal(JSON.stringify(read).includes('secret'), false);
});

test('read-only mode denies mutations at the executor and cancellation preserves queue semantics', async () => {
  const f = fixture({ allowControl: false });
  f.ctx.sessionController.prompt = () => { throw new Error('should not reach prompt'); };
  await assert.rejects(f.controller.execute({ operation: 'send' }, signal()), { code: 'read-only' });
  await assert.rejects(f.controller.execute({ operation: 'interrupt' }, signal()), { code: 'read-only' });
  const g = fixture();
  const result = await g.controller.execute({ operation: 'interrupt', sessionId: 's1' }, signal());
  assert.equal(result.preservesQueue, true);
  assert.equal(result.scope, 'current-turn');
});

test('concurrent sends serialize native admission so persisted requestId deduplication can succeed', async () => {
  const f = fixture();
  let concurrent = 0;
  let maxConcurrent = 0;
  const accepted = new Set();
  const forwarded = [];
  f.ctx.sessionController.prompt = async request => {
    forwarded.push(request);
    concurrent++;
    maxConcurrent = Math.max(concurrent, maxConcurrent);
    const exists = accepted.has(request.requestId);
    await new Promise(resolve => setImmediate(resolve));
    if (!exists) accepted.add(request.requestId);
    concurrent--;
    return { accepted: true };
  };
  const request = { operation: 'send', sessionId: 's1', requestId: 'retry1', text: 'continue' };
  await Promise.all([f.controller.execute(request, signal()), f.controller.execute(request, signal())]);
  assert.equal(maxConcurrent, 1);
  assert.equal(accepted.size, 1);
  assert.deepEqual(forwarded.map(item => item.requestId), ['retry1', 'retry1']);
});

test('wait receives events without polling and stale parent cursors see descendant transitions', async () => {
  const f = fixture();
  const before = await f.controller.status('s1', signal());
  const pending = f.controller.wait({ sessionId: 's1', cursor: before.cursor }, signal());
  await new Promise(resolve => setImmediate(resolve));
  f.emitter.emit('agent/status', { agent: f.agent });
  const update = await pending;
  assert.equal(update.changed, true);
  assert.notEqual(update.cursor, before.cursor);
  const child = { id: 'child', session: { header: { parentSession: 's1' } } };
  f.emitter.emit('agent/disposed', { agent: child });
  const stale = await f.controller.wait({ sessionId: 's1', cursor: update.cursor, timeoutMs: 0 }, signal());
  assert.equal(stale.changed, true);
});

test('abort/disposal during deferred status does not leave an unhandled wake rejection', async () => {
  const f = fixture();
  const original = f.controller.status.bind(f.controller);
  let resolveStatus;
  f.controller.status = () => new Promise(resolve => { resolveStatus = resolve; });
  const waiting = f.controller.wait({ sessionId: 's1' }, signal());
  const rejected = assert.rejects(waiting, { code: 'bridge-disposed' });
  f.controller.dispose();
  await new Promise(resolve => setImmediate(resolve));
  resolveStatus(await original('s1', signal()));
  await rejected;
});

test('invalid bounds and empty prompts are rejected before runtime calls', async () => {
  const f = fixture();
  await assert.rejects(f.controller.execute({ operation: 'sessions', limit: 201 }, signal()), { code: 'invalid-request' });
  await assert.rejects(f.controller.execute({ operation: 'send', sessionId: 's1', requestId: 'r', text: '  ' }, signal()), { code: 'invalid-request' });
  await assert.rejects(f.controller.wait({ sessionId: 's1', timeoutMs: 45001 }, signal()), { code: 'invalid-request' });
});
