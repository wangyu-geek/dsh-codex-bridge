/** DSH Host plugin: authenticated local control of the original runtime, without starting another agent. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rename, unlink, lstat, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { HostController, BridgeError } from './host-controller.js';
import { projectionDefinition } from './session-state.js';
import { ROUTE, PROTOCOL_VERSION, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, discoveryDirectory } from './protocol.js';

export const name = 'codex-bridge';
export const inject = ['webServer', 'sessionController', 'sessionProjections', 'sessions', 'agents'];

const configSchema = z.object({
  allowControl: z.boolean().default(false),
  discoveryDirectory: z.string().min(1).optional(),
}).strict();

function authorized(header, token) {
  if (typeof header !== 'string') return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function localAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function writeJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    status = 413;
    body = JSON.stringify({ ok: false, error: { code: 'response-too-large', message: 'Narrow the requested history or session limit.' } });
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

/** HTTP entry point exported for focused tests; authentication precedes all runtime access. */
export function createRequestHandler(controller, token) {
  return async (request, response) => {
    const abort = new AbortController();
    const close = () => { if (!response.writableEnded) abort.abort(new BridgeError('cancelled', 'Client disconnected', 499)); };
    response.on('close', close);
    try {
      if (!localAddress(request.socket.remoteAddress)) throw new BridgeError('local-only', 'The bridge accepts loopback clients only', 403);
      if (request.headers.origin !== undefined) throw new BridgeError('origin-not-allowed', 'Browser-origin requests are not accepted', 403);
      if (!authorized(request.headers.authorization, token)) throw new BridgeError('unauthorized', 'DSH bridge authentication is required', 401);
      if (request.method !== 'POST') throw new BridgeError('method-not-allowed', 'Use POST for bridge requests', 405);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new BridgeError('invalid-content-type', 'Use application/json', 415);
      const length = Number(request.headers['content-length'] ?? 0);
      if (!Number.isFinite(length) || length < 0 || length > MAX_REQUEST_BYTES) throw new BridgeError('request-too-large', 'Bridge request body exceeds the limit', 413);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) throw new BridgeError('request-too-large', 'Bridge request body exceeds the limit', 413);
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new BridgeError('invalid-json', 'Request body must be valid JSON'); }
      const data = await controller.execute(input, abort.signal);
      writeJson(response, 200, { ok: true, data });
    } catch (error) {
      const known = error instanceof BridgeError;
      const sourceCode = typeof error?.code === 'string' ? error.code : undefined;
      writeJson(response, known ? error.status : sourceCode === 'session/not-found' ? 404 : 500, {
        ok: false,
        error: { code: known ? error.code : sourceCode ?? 'operation-failed',
          message: known ? error.message : 'The DSH operation failed; inspect its session or local diagnostics.' },
      });
    } finally {
      response.off('close', close);
    }
  };
}

/** Register resources on the plugin fiber; its unload never stops the DSH runtime. */
export async function apply(ctx, rawConfig = {}) {
  const config = configSchema.parse(rawConfig);
  await ctx.sessionProjections.register(projectionDefinition);
  const origin = new URL(ctx.webServer.getOrigin());
  if (origin.hostname === '0.0.0.0') origin.hostname = '127.0.0.1';
  if (origin.hostname === '[::]') origin.hostname = '[::1]';
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)) throw new Error('Codex bridge requires a loopback or wildcard DSH Web listener');
  if (origin.hostname === 'localhost') origin.hostname = '127.0.0.1';
  const instanceId = randomUUID();
  const token = randomBytes(32).toString('hex');
  const startedAt = Date.now();
  const directory = resolve(config.discoveryDirectory ?? discoveryDirectory());
  const file = join(directory, `${instanceId}.json`);
  const temporary = `${file}.tmp`;
  const controller = new HostController(ctx, { instanceId, startedAt, allowControl: config.allowControl });
  const lifetime = new AbortController();
  controller.observe();
  ctx.effect(() => {
    const unregister = ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: createRequestHandler(controller, token) });
    return async () => {
      lifetime.abort();
      unregister();
      controller.dispose();
      await Promise.all([file, temporary].map(async path => {
        try { await unlink(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }));
    };
  }, 'codex-bridge.endpoint');
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('Bridge discovery directory must be an owned real directory');
    await chmod(directory, 0o700);
    lifetime.signal.throwIfAborted();
    await writeFile(temporary, JSON.stringify({ schemaVersion: PROTOCOL_VERSION, instanceId,
      endpoint: new URL(ROUTE, origin).href, token, pid: process.pid, startedAt,
      profile: process.env.DSH_PROFILE ?? 'web', readOnly: !config.allowControl,
    }) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    lifetime.signal.throwIfAborted();
    await rename(temporary, file);
    if (lifetime.signal.aborted) {
      await unlink(file);
      lifetime.signal.throwIfAborted();
    }
  } catch (error) {
    for (const path of [temporary, file]) {
      try { await unlink(path); }
      catch (cleanupError) { if (cleanupError.code !== 'ENOENT') ctx.logger?.warn('Codex bridge discovery cleanup failed'); }
    }
    throw error;
  }
}
