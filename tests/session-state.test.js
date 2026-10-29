import test from 'node:test';
import assert from 'node:assert/strict';
import { applySessionEvent, initialSessionState, displayRecord, boundedText } from '../src/session-state.js';

test('session facts retain visible replies, explicit ending reasons and artifacts only', () => {
  let state = initialSessionState();
  state = applySessionEvent(state, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } });
  state = applySessionEvent(state, { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, message: { content: [
    { type: 'reasoning', text: 'private thoughts' }, { type: 'text', text: 'visible result' },
    { type: 'tool-call', id: 'call1', name: 'bash', arguments: 'private inputs' },
  ] } } });
  assert.equal(state.lastReply.text, 'visible result');
  assert.equal(state.tools[0].name, 'bash');
  state = applySessionEvent(state, { type: 'approval/asked', data: { id: 'approve1', toolName: 'bash', reason: 'needs confirmation' } });
  assert.equal(state.approvals.length, 1);
  state = applySessionEvent(state, { type: 'approval/decided', data: { id: 'approve1' } });
  assert.equal(state.approvals.length, 0);
  state = applySessionEvent(state, { type: 'deliverables/presented', data: { turn: 1, files: [{ path: '/tmp/result.md', description: 'report' }] } });
  state = applySessionEvent(state, { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'error', error: { code: 'provider-error', message: 'request failed' } } } });
  assert.equal(state.lastEnd.reason.kind, 'error');
  assert.equal(state.artifacts[0].path, '/tmp/result.md');
  assert.equal(state.openTurn, null);
  assert.equal(JSON.stringify(state).includes('private'), false);
});

test('unknown event and ending variants preserve compatibility without exposing private payload', () => {
  const initial = initialSessionState();
  assert.equal(applySessionEvent(initial, { type: 'unknown', data: {} }), initial);
  const ended = applySessionEvent(initial, { type: 'turn/end', seq: 1, time: 2,
    data: { turn: 1, reason: { kind: 'future-reason', secret: 'do not export' } } });
  assert.deepEqual(ended.lastEnd.reason, { kind: 'future-reason' });
  assert.equal(displayRecord({ type: 'request/header', data: { credentials: 'secret' } }), null);
});

test('UTF-8 truncation respects the byte limit and complete code points', () => {
  assert.deepEqual(boundedText('中文🙂', 7), { text: '中文', truncated: true });
  assert.deepEqual(boundedText('中文🙂', 10), { text: '中文🙂', truncated: false });
});
