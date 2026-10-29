/** Bounded incremental session facts. No request headers, reasoning, or tool arguments are exported. */
import { z } from 'zod';

export const PROJECTION_KEY = 'codexBridgeStatus';
const TEXT_BYTES = 8192;

/** UTF-8-safe prefix with an explicit truncation marker. */
export function boundedText(value, bytes = TEXT_BYTES) {
  const text = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(text) <= bytes) return { text, truncated: false };
  let result = '';
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes) break;
    used += size;
    result += char;
  }
  return { text: result, truncated: true };
}

/** Read display text only; private reasoning and serialized tool inputs are omitted. */
export function messageText(content) {
  if (typeof content === 'string') return boundedText(content);
  if (!Array.isArray(content)) return { text: '', truncated: false };
  return boundedText(content.filter(block => block?.type === 'text').map(block => block.text).join('\n'));
}

function endReason(reason) {
  if (!reason || typeof reason.kind !== 'string') return { kind: 'unknown' };
  const result = { kind: reason.kind };
  if (reason.error?.code !== undefined) result.code = boundedText(String(reason.error.code), 256).text;
  if (reason.error?.message !== undefined) result.message = boundedText(reason.error.message, 2048).text;
  if (reason.reason?.kind !== undefined) result.cause = boundedText(reason.reason.kind, 256).text;
  return result;
}

export function initialSessionState() {
  return { lastTurn: 0, openTurn: null, lastEnd: null, lastReply: null, artifacts: [], approvals: [], tools: [] };
}

/** Fold only bridge-visible facts; unchanged events reuse the previous value. */
export function applySessionEvent(state, event) {
  const data = event.data ?? {};
  switch (event.type) {
    case 'turn/start':
      return { ...state, lastTurn: data.turn, openTurn: data.turn, approvals: [], tools: [], artifacts: [] };
    case 'turn/end':
      return { ...state, openTurn: null, approvals: [], tools: [], lastEnd: {
        turn: data.turn, seq: event.seq, time: event.time, reason: endReason(data.reason),
      } };
    case 'assistant/message': {
      const body = messageText(data.message?.content ?? data.content);
      const calls = (data.message?.content ?? data.content ?? []).filter?.(block => block?.type === 'tool-call') ?? [];
      const tools = [...state.tools, ...calls.map(call => ({ callId: call.id, name: boundedText(call.name, 200).text }))].slice(-32);
      return { ...state, tools, ...(body.text ? { lastReply: { turn: data.turn, seq: event.seq, time: event.time, ...body } } : {}) };
    }
    case 'tool/result': {
      const callId = data.message?.toolCallId ?? data.callId;
      return { ...state, tools: state.tools.filter(tool => tool.callId !== callId) };
    }
    case 'approval/asked':
      return { ...state, approvals: [...state.approvals, {
        id: data.id, toolName: boundedText(data.toolName, 200).text,
        reason: boundedText(data.reason, 1024).text,
      }].slice(-32) };
    case 'approval/decided':
      return { ...state, approvals: state.approvals.filter(approval => approval.id !== data.id) };
    case 'deliverables/presented':
      return { ...state, artifacts: (data.files ?? []).slice(0, 16).map(file => ({
        path: boundedText(file.path, 4096).text,
        description: boundedText(file.description, 1024).text,
        turn: data.turn,
      })) };
    default:
      return state;
  }
}

/** The registry supplies replay, checkpointing and disposal with the owning plugin fiber. */
export const projectionDefinition = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: z.json(),
  init: initialSessionState,
  apply: applySessionEvent,
  wire: { viewSchema: z.json(), view: state => state, summary: false },
};

export function questionCounts(values) {
  const view = values.userQuestions?.questions ?? values.userQuestions;
  const active = Array.isArray(view?.active) ? view.active : [];
  return {
    open: active.filter(question => question.state !== 'continued').length,
    continued: active.filter(question => question.state === 'continued').length,
  };
}

export function queueCounts(values) {
  return {
    nextTurn: Array.isArray(values.inbox?.['next-turn']) ? values.inbox['next-turn'].length : 0,
    nextStep: Array.isArray(values.inbox?.['next-step']) ? values.inbox['next-step'].length : 0,
  };
}

/** Safe per-event history view; model reasoning, request/config and tool inputs are excluded. */
export function displayRecord(event) {
  const data = event.data ?? {};
  const common = { type: event.type, seq: event.seq, time: event.time, turn: data.turn };
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    // DSH also logs runtime injections in user-role messages; they are not human instructions.
    if (event.type === 'user/message' && !['user', 'user-question-reply'].includes(data.source?.kind)) return null;
    const body = messageText(data.message?.content ?? data.content);
    if (!body.text) return null;
    return { ...common, role: event.type === 'user/message' ? 'user' : 'assistant',
      ...(event.type === 'user/message' ? { sourceKind: data.source.kind,
        ...(typeof data.source.rpcId === 'string' ? { requestId: data.source.rpcId } : {}),
      } : {}), ...body };
  }
  if (event.type === 'tool/result') {
    return { ...common, role: 'tool', callId: data.message?.toolCallId ?? data.callId,
      isError: data.message?.isError === true, ...messageText(data.message?.content ?? data.content) };
  }
  if (event.type === 'turn/start') return common;
  if (event.type === 'turn/end') return { ...common, reason: endReason(data.reason) };
  return null;
}
