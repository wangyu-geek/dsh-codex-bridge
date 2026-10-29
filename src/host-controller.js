/** Stable bridge operations over the original runtime's Session services. */
import { MAX_WAIT_MS, PROTOCOL_VERSION } from './protocol.js';
import { PROJECTION_KEY, boundedText, displayRecord, initialSessionState, questionCounts, queueCounts } from './session-state.js';

export class BridgeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function integer(value, fallback, minimum, maximum, field) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BridgeError('invalid-request', `${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requiredString(value, field, maximum = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new BridgeError('invalid-request', `${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function titleOf(values) {
  const title = values.title;
  return boundedText(typeof title === 'string' ? title : title?.title ?? '', 512).text;
}

function summarize(row) {
  const values = row.projections?.values ?? {};
  return {
    sessionId: row.sessionId, title: titleOf(values), cwd: boundedText(row.cwd, 2048).text,
    updatedAt: row.updatedAt, attached: row.agentAvailable, running: row.agentAvailable ? row.running : null,
    parentSessionId: row.parentSessionId ?? null, origin: row.origin ?? null,
    source: row.projections?.kind === 'sequenced' ? 'live' : 'stored',
    asOfSeq: row.projections?.asOfSeq ?? null,
    lastUserMessageAt: values.sessionListMetadata?.lastPromptAt ?? null,
  };
}

function conversationTime(row) {
  return row.projections?.values?.sessionListMetadata?.lastPromptAt ?? row.updatedAt;
}

function matchesWorkspace(cwd, workspace) {
  if (!workspace) return true;
  const actual = (cwd ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  const requested = workspace.replaceAll('\\', '/').replace(/\/+$/, '');
  return requested.includes('/')
    ? actual === requested || actual.startsWith(`${requested}/`)
    : actual.split('/').includes(requested);
}

function localTime(time, timeZone) {
  return typeof time === 'number' && Number.isFinite(time)
    ? new Date(time).toLocaleString('sv-SE', { timeZone, hour12: false }) : null;
}

/** Owns process-local change revisions and bounded, event-driven wait requests. */
export class HostController {
  constructor(ctx, { instanceId, startedAt, allowControl }) {
    this.ctx = ctx;
    this.instanceId = instanceId;
    this.startedAt = startedAt;
    this.allowControl = allowControl;
    this.revisions = new Map();
    this.waiters = new Set();
    this.admissions = new Map();
    this.closed = false;
  }

  /** Register only ordinary observation events; no approval answerer is installed. */
  observe() {
    this.ctx.on('session/event', session => this.changed(session.id, session.header?.parentSession), { global: true });
    this.ctx.on('agent/status', ({ agent }) => this.changed(agent.id, agent.session?.header?.parentSession), { global: true });
    this.ctx.on('agent/created', ({ agent }) => this.changed(agent.id, agent.session?.header?.parentSession), { global: true });
    this.ctx.on('agent/disposed', ({ agent }) => this.changed(agent.id, agent.session?.header?.parentSession), { global: true });
    this.ctx.on('session/disposed', session => this.changed(session.id, session.header?.parentSession), { global: true });
  }

  changed(sessionId, parentSessionId) {
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
    for (const waiter of this.waiters) {
      if (waiter.sessionId === sessionId) waiter.finish(true);
    }
    if (parentSessionId && parentSessionId !== sessionId) {
      this.changed(parentSessionId, this.ctx.sessions.get(parentSessionId)?.header?.parentSession);
    }
  }

  dispose() {
    this.closed = true;
    for (const waiter of this.waiters) waiter.fail(new BridgeError('bridge-disposed', 'DSH bridge was unloaded', 503));
    this.waiters.clear();
    this.revisions.clear();
  }

  async projections(sessionId, signal) {
    const session = this.ctx.sessions.get(sessionId);
    if (session !== undefined) {
      const snapshot = this.ctx.sessionProjections.snapshot(session);
      return { ...snapshot, kind: 'sequenced' };
    }
    const projection = await this.ctx.sessionController.projections({ sessionId }, signal);
    if (projection === null) throw new BridgeError('session-not-found', 'The requested DSH session was not found', 404);
    return projection;
  }

  cursor(sessionId, projection) {
    return `${this.instanceId}:${sessionId}:${projection.asOfSeq ?? -1}:${this.revisions.get(sessionId) ?? 0}`;
  }

  async status(sessionId, signal) {
    const projection = await this.projections(sessionId, signal);
    signal.throwIfAborted();
    const session = this.ctx.sessions.get(sessionId);
    const current = session === undefined ? projection : this.ctx.sessionProjections.snapshot(session);
    const values = current.values ?? {};
    const facts = values[PROJECTION_KEY] ?? initialSessionState();
    const agent = this.ctx.agents.get(sessionId);
    const agents = this.ctx.agents.list();
    const descendants = new Set([sessionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of agents) {
        if (!descendants.has(child.id) && descendants.has(child.session?.header?.parentSession)) {
          descendants.add(child.id);
          changed = true;
        }
      }
    }
    const allChildren = agents.filter(child => child.id !== sessionId && descendants.has(child.id));
    const children = allChildren.slice(0, 100).map(child => ({
      sessionId: child.id, parentSessionId: child.session?.header?.parentSession ?? null,
      running: child.status === 'running',
    }));
    const questions = questionCounts(values);
    const queued = queueCounts(values);
    const running = agent === undefined ? null : agent.status === 'running';
    let activity = running === null ? 'unknown' : running ? 'thinking' : 'idle';
    if (running === true && facts.tools.length) activity = 'tool';
    if (agent !== undefined && questions.open > 0) activity = 'waiting-answer';
    if (agent !== undefined && facts.approvals.length > 0) activity = 'waiting-approval';
    const boundary = values.turnBoundary;
    const currentTurn = boundary?.lastTurn ?? facts.lastTurn;
    return {
      instanceId: this.instanceId, sessionId, connection: 'online', observedAt: Date.now(),
      source: session === undefined ? 'stored' : 'live', attached: agent !== undefined,
      runtimeState: running === null ? 'unknown' : running ? 'running' : 'idle', running, activity,
      title: titleOf(values), cwd: boundedText(values.workingDirectory ?? session?.header?.cwd, 2048).text,
      asOfSeq: current.asOfSeq ?? null, cursor: this.cursor(sessionId, current),
      currentTurn, lastTurn: currentTurn, turnOpen: boundary?.openTurnStartSeq !== undefined
        ? boundary.openTurnStartSeq !== null : facts.openTurn !== null,
      lastEnd: facts.lastEnd, lastReply: facts.lastReply, artifacts: facts.artifacts,
      pendingApprovals: facts.approvals, pendingQuestions: questions, queued, children, childCount: allChildren.length,
      quiescent: agent === undefined ? null : !running && questions.open === 0 && facts.approvals.length === 0
        && queued.nextTurn === 0 && queued.nextStep === 0 && !allChildren.some(child => child.status === 'running'),
      goalCompletion: 'not-evaluated',
      readOnly: !this.allowControl,
    };
  }

  async read(request, signal) {
    const sessionId = requiredString(request.sessionId, 'sessionId');
    const status = await this.status(sessionId, signal);
    if (status.asOfSeq === null) throw new BridgeError('migration-required', 'Session history needs a supported persistence migration', 409);
    const maxMessages = integer(request.maxMessages, 20, 1, 40, 'maxMessages');
    const beforeSeq = integer(request.beforeSeq, undefined, 0, status.asOfSeq + 1, 'beforeSeq');
    const result = await this.ctx.sessionController.page({
      address: { kind: 'session', sessionId }, throughSeq: status.asOfSeq, maxMessages,
      ...(beforeSeq === undefined ? { turnWindow: { minMessages: 1, minTurns: 1 } } : { beforeSeq }),
    }, signal);
    const events = result.records.map(record => record.event).filter(Boolean);
    const turnStart = beforeSeq === undefined
      ? events.findLastIndex(event => event.type === 'turn/start' && event.data?.turn === status.currentTurn) : -1;
    const selected = turnStart === -1 ? events : events.slice(turnStart);
    let turn = beforeSeq === undefined ? status.currentTurn : undefined;
    const records = selected.map(event => {
      if (event.type === 'turn/start') turn = event.data.turn;
      const record = displayRecord(event);
      return record === null ? null : { ...record, turn: record.turn ?? turn };
    }).filter(Boolean);
    return { status, records, hasMore: result.hasMore, beforeSeq: events[0]?.seq ?? null,
      throughSeq: status.asOfSeq, scope: beforeSeq === undefined ? 'latest-turn' : 'history-page' };
  }

  /** Recent root conversations, selected by DSH's last user activity rather than creation date. */
  async recent(request, signal) {
    const limit = integer(request.limit, 10, 1, 20, 'limit');
    const offset = integer(request.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const workspace = request.workspace === undefined ? undefined : requiredString(request.workspace, 'workspace', 4096);
    const query = request.query === undefined ? '' : requiredString(request.query, 'query', 512).toLocaleLowerCase();
    if (request.includeSubagents !== undefined && typeof request.includeSubagents !== 'boolean') {
      throw new BridgeError('invalid-request', 'includeSubagents must be boolean');
    }
    const timeZone = request.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { new Intl.DateTimeFormat('en', { timeZone }).format(); }
    catch { throw new BridgeError('invalid-request', 'timeZone must be a valid IANA time zone'); }
    const listed = await this.ctx.sessionController.list({}, signal);
    const rows = listed.items.filter(row => !row.blank
      && (request.includeSubagents || (!row.parentSessionId && row.origin !== 'subagent'))
      && matchesWorkspace(row.cwd, workspace)
      && (!query || `${titleOf(row.projections?.values ?? {})}\n${row.cwd ?? ''}`.toLocaleLowerCase().includes(query)))
      .sort((left, right) => conversationTime(right) - conversationTime(left) || left.sessionId.localeCompare(right.sessionId));
    const sessions = [];
    for (const row of rows.slice(offset, offset + limit)) {
      signal.throwIfAborted();
      try {
        const status = await this.status(row.sessionId, signal);
        const reply = status.lastReply;
        const text = boundedText(reply?.text, 1600);
        sessions.push({
          ...summarize(row), lastConversationAt: conversationTime(row),
          conversationTimeBasis: row.projections?.values?.sessionListMetadata?.lastPromptAt == null ? 'list-activity' : 'last-user-message',
          lastConversationTime: localTime(conversationTime(row), timeZone),
          activity: status.activity, runtimeState: status.runtimeState, lastTurn: status.lastTurn,
          lastEnd: status.lastEnd, lastEndTime: localTime(status.lastEnd?.time, timeZone),
          lastReply: reply ? { ...reply, ...text, truncated: Boolean(reply.truncated || text.truncated),
            timeText: localTime(reply.time, timeZone) } : null,
          artifacts: status.artifacts, quiescent: status.quiescent, goalCompletion: status.goalCompletion,
          source: status.source, asOfSeq: status.asOfSeq,
        });
      } catch (error) {
        signal.throwIfAborted();
        sessions.push({ ...summarize(row), lastConversationAt: conversationTime(row),
          lastConversationTime: localTime(conversationTime(row), timeZone),
          resultError: { code: typeof error?.code === 'string' ? error.code : 'RESULT_UNAVAILABLE',
            message: 'This conversation is listed, but its latest result could not be read.' } });
      }
    }
    const observedAt = Date.now();
    const nextOffset = offset + sessions.length < rows.length ? offset + sessions.length : null;
    return { source: 'dsh-runtime', instanceId: this.instanceId, observedAt,
      observedAtText: localTime(observedAt, timeZone), timeZone,
      sortBy: 'last-user-activity', scope: request.includeSubagents ? 'all-conversations' : 'root-conversations',
      workspace: workspace ?? null, total: rows.length, sessions, nextOffset, hasMore: nextOffset !== null };
  }

  async wait(request, signal) {
    const sessionId = requiredString(request.sessionId, 'sessionId');
    const timeoutMs = integer(request.timeoutMs, 30_000, 0, MAX_WAIT_MS, 'timeoutMs');
    const expected = request.cursor;
    if (expected !== undefined && (typeof expected !== 'string' || expected.length > 2048)) {
      throw new BridgeError('invalid-request', 'cursor must be a string of at most 2048 characters');
    }
    let release;
    let reject;
    const wake = new Promise((resolve, fail) => { release = resolve; reject = fail; });
    // A status lookup can reject before the wait is entered; retain a rejection observer for that path.
    wake.catch(() => {});
    const waiter = { sessionId, finish: release, fail: reject };
    this.waiters.add(waiter);
    let timer;
    const abort = () => reject(signal.reason ?? new BridgeError('cancelled', 'Bridge request was cancelled', 499));
    signal.addEventListener('abort', abort, { once: true });
    try {
      const initial = await this.status(sessionId, signal);
      if (expected !== undefined && expected !== initial.cursor) return { changed: true, cursor: initial.cursor, status: initial };
      if (timeoutMs === 0) return { changed: false, cursor: initial.cursor, status: initial };
      timer = setTimeout(() => release(false), timeoutMs);
      const changed = await wake;
      const status = await this.status(sessionId, signal);
      return { changed, cursor: status.cursor, status };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      this.waiters.delete(waiter);
    }
  }

  async execute(request, signal) {
    if (this.closed) throw new BridgeError('bridge-disposed', 'DSH bridge is no longer active', 503);
    signal.throwIfAborted();
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new BridgeError('invalid-request', 'Expected a JSON object');
    switch (request.operation) {
      case 'capabilities':
        return { protocolVersion: PROTOCOL_VERSION, instanceId: this.instanceId, startedAt: this.startedAt,
          profile: process.env.DSH_PROFILE ?? 'web', readOnly: !this.allowControl,
          operations: ['recent', 'sessions', 'status', 'read', 'wait', ...(this.allowControl ? ['send', 'interrupt'] : [])] };
      case 'recent':
        return this.recent(request, signal);
      case 'sessions': {
        const limit = integer(request.limit, 50, 1, 200, 'limit');
        const offset = integer(request.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const result = await this.ctx.sessionController.list({}, signal);
        const end = Math.min(offset + limit, result.items.length);
        return { instanceId: this.instanceId, observedAt: Date.now(), total: result.items.length,
          sessions: result.items.slice(offset, end).map(summarize), offset,
          nextOffset: end < result.items.length ? end : null, hasMore: end < result.items.length };
      }
      case 'status':
        return this.status(requiredString(request.sessionId, 'sessionId'), signal);
      case 'read':
        return this.read(request, signal);
      case 'wait':
        return this.wait(request, signal);
      case 'send': {
        if (!this.allowControl) throw new BridgeError('read-only', 'This DSH bridge has control disabled', 403);
        const sessionId = requiredString(request.sessionId, 'sessionId');
        const requestId = requiredString(request.requestId, 'requestId');
        const text = requiredString(request.text, 'text', 131_072);
        const mode = request.mode ?? 'queue';
        if (mode !== 'queue' && mode !== 'steer') throw new BridgeError('invalid-request', 'mode must be queue or steer');
        const previous = this.admissions.get(sessionId) ?? Promise.resolve();
        const admission = previous.catch(() => {}).then(() => {
          signal.throwIfAborted();
          return this.ctx.sessionController.prompt({ sessionId, requestId, mode,
            content: [{ type: 'text', text }] }, signal);
        });
        this.admissions.set(sessionId, admission);
        let result;
        try { result = await admission; }
        finally { if (this.admissions.get(sessionId) === admission) this.admissions.delete(sessionId); }
        return { ...result, sessionId, requestId, mode, note: 'Accepted input is not proof the task has completed.' };
      }
      case 'interrupt': {
        if (!this.allowControl) throw new BridgeError('read-only', 'This DSH bridge has control disabled', 403);
        const sessionId = requiredString(request.sessionId, 'sessionId');
        return { ...this.ctx.sessionController.cancel({ sessionId }), sessionId,
          scope: 'current-turn', preservesQueue: true, note: 'Cancellation was requested; read status or wait for the ending event.' };
      }
      default:
        throw new BridgeError('unknown-operation', 'Unsupported DSH bridge operation');
    }
  }
}
