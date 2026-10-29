/** Local discovery and bounded, authenticated calls to the running DSH plugin. */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { discoveryDirectory, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_WAIT_MS, PROTOCOL_VERSION, ROUTE } from './protocol.js';

const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MUTATIONS = new Set(['send', 'interrupt']);

/** An actionable failure that never embeds a credential or HTTP header. */
export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function privateOwner(stats, mode, label) {
  if (process.platform !== 'win32' && ((stats.mode & 0o777) !== mode || stats.uid !== process.getuid())) {
    throw new BridgeError('INSECURE_DISCOVERY', `${label} must be owned by this user with mode ${mode.toString(8)}.`);
  }
}

function endpointUrl(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch {
    throw new BridgeError('INVALID_DISCOVERY', 'The instance endpoint is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== ROUTE) {
    throw new BridgeError('INVALID_DISCOVERY', 'The instance endpoint must be a numeric loopback bridge URL.');
  }
  return url.href;
}

function validateDescriptor(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== PROTOCOL_VERSION || typeof value.instanceId !== 'string'
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.instanceId) || typeof value.endpoint !== 'string'
    || typeof value.token !== 'string' || value.token.length < 32 || value.token.length > 512
    || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isFinite(value.startedAt)
    || typeof value.profile !== 'string' || typeof value.readOnly !== 'boolean') {
    throw new BridgeError('INVALID_DISCOVERY', 'The instance descriptor has invalid or unsupported fields.');
  }
  return { ...value, endpoint: endpointUrl(value.endpoint) };
}

/** Read credentials through an owned descriptor handle, refusing symbolic links. */
async function readDescriptor(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_DESCRIPTOR_BYTES) {
      throw new BridgeError('INVALID_DISCOVERY', 'The instance descriptor is not a bounded regular file.');
    }
    privateOwner(stats, 0o600, 'Instance descriptor');
    const bytes = Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_DESCRIPTOR_BYTES) throw new BridgeError('INVALID_DISCOVERY', 'The instance descriptor is too large.');
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8', 0, bytesRead)); } catch {
      throw new BridgeError('INVALID_DISCOVERY', 'The instance descriptor is not valid JSON.');
    }
    return validateDescriptor(parsed);
  } finally {
    await handle.close();
  }
}

function publicDescriptor(descriptor) {
  return {
    instanceId: descriptor.instanceId,
    endpoint: descriptor.endpoint,
    pid: descriptor.pid,
    startedAt: descriptor.startedAt,
    profile: descriptor.profile,
    readOnly: descriptor.readOnly,
    protocolVersion: descriptor.schemaVersion,
  };
}

function redact(value, token) {
  if (typeof value === 'string') return value.replaceAll(token, '[redacted]');
  if (Array.isArray(value)) return value.map(item => redact(item, token));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['token', 'authorization'].includes(key.toLowerCase()))
      .map(([key, item]) => [key.replaceAll(token, '[redacted]'), redact(item, token)]));
  }
  return value;
}

async function boundedJson(response) {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new BridgeError('RESPONSE_TOO_LARGE', 'The bridge response exceeded its size limit. Read a smaller history page.');
  }
  if (!response.body) throw new BridgeError('INVALID_RESPONSE', 'The bridge returned no response body.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new BridgeError('RESPONSE_TOO_LARGE', 'The bridge response exceeded its size limit. Read a smaller history page.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new BridgeError('INVALID_RESPONSE', 'The bridge returned invalid JSON.');
  }
}

/** A local client; discovery credentials remain private to this object. */
export class BridgeClient {
  constructor({ directory = discoveryDirectory(), fetchImpl = fetch, requestTimeoutMs = 10_000 } = {}) {
    this.directory = directory;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async discover() {
    let directoryStats;
    try { directoryStats = await lstat(this.directory); } catch (error) {
      if (error.code === 'ENOENT') return { descriptors: [], invalid: [] };
      throw new BridgeError('DISCOVERY_UNAVAILABLE', 'The local DSH instance directory cannot be read.');
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new BridgeError('INSECURE_DISCOVERY', 'The DSH instance directory must be a real directory.');
    }
    privateOwner(directoryStats, 0o700, 'Instance directory');
    const entries = await readdir(this.directory, { withFileTypes: true });
    const descriptors = [];
    const invalid = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      if (descriptors.length + invalid.length >= 128) {
        throw new BridgeError('DISCOVERY_LIMIT', 'Too many local instance descriptors. Remove stale instances before continuing.');
      }
      try {
        if (!entry.isFile()) throw new BridgeError('INVALID_DISCOVERY', 'An instance descriptor must be a regular file, without symbolic links.');
        const descriptor = await readDescriptor(join(this.directory, entry.name));
        if (entry.name !== `${descriptor.instanceId}.json` || descriptors.some(item => item.instanceId === descriptor.instanceId)) {
          throw new BridgeError('INVALID_DISCOVERY', 'The instance identity does not match its descriptor filename.');
        }
        descriptors.push(descriptor);
      } catch (error) {
        invalid.push({ descriptor: entry.name, online: false, error: {
          code: error instanceof BridgeError ? error.code : 'INVALID_DISCOVERY',
          message: error instanceof BridgeError ? error.message : 'The instance descriptor cannot be read safely.',
        } });
      }
    }
    return { descriptors, invalid };
  }

  async instances({ signal } = {}) {
    const { descriptors, invalid } = await this.discover();
    const instances = await Promise.all(descriptors.map(async descriptor => {
      try {
        const capabilities = await this.callDescriptor(descriptor, { operation: 'capabilities' }, { signal });
        return { ...publicDescriptor(descriptor), online: true, capabilities };
      } catch (error) {
        return { ...publicDescriptor(descriptor), online: false, error: {
          code: error instanceof BridgeError ? error.code : 'INSTANCE_OFFLINE',
          message: error instanceof BridgeError ? error.message : 'The DSH instance is unavailable.',
        } };
      }
    }));
    return { instances, invalid };
  }

  async resolve(instanceId, signal) {
    const { descriptors } = await this.discover();
    if (instanceId !== undefined) {
      const descriptor = descriptors.find(item => item.instanceId === instanceId);
      if (!descriptor) throw new BridgeError('INSTANCE_NOT_FOUND', 'The requested DSH instance was not found. Call dsh_instances.');
      return descriptor;
    }
    if (descriptors.length === 0) throw new BridgeError('NO_INSTANCES', 'No DSH bridge instances were found. Start DSH with the Codex bridge plugin.');
    if (descriptors.length === 1) return descriptors[0];
    const online = await Promise.all(descriptors.map(async descriptor => {
      try {
        await this.callDescriptor(descriptor, { operation: 'capabilities' }, { signal });
        return descriptor;
      } catch { return undefined; }
    }));
    const candidates = online.filter(Boolean);
    if (candidates.length === 0) throw new BridgeError('INSTANCE_OFFLINE', 'No discovered DSH instance is online. Call dsh_instances for details.');
    if (candidates.length > 1) throw new BridgeError('AMBIGUOUS_INSTANCE', 'Multiple DSH instances are online. Supply the exact instanceId from dsh_instances.');
    return candidates[0];
  }

  /** Calls never retry a mutation: a lost response must be reconciled with its stable requestId. */
  async request(operation, args = {}, { signal } = {}) {
    const { instanceId, ...parameters } = args;
    const descriptor = await this.resolve(instanceId, signal);
    if (MUTATIONS.has(operation) && descriptor.readOnly) throw new BridgeError('READ_ONLY', 'This DSH instance permits observation only.');
    const data = await this.callDescriptor(descriptor, { ...parameters, operation }, { signal });
    return { instanceId: descriptor.instanceId, data };
  }

  async callDescriptor(descriptor, body, { signal } = {}) {
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw new BridgeError('REQUEST_TOO_LARGE', 'The instruction or request is too large.');
    const timeoutMs = body.operation === 'wait' ? Math.min(body.timeoutMs ?? MAX_WAIT_MS, MAX_WAIT_MS) + 5_000 : this.requestTimeoutMs;
    const combinedSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...signal ? [signal] : []]);
    let response;
    try {
      response = await this.fetchImpl(descriptor.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
        redirect: 'error',
        signal: combinedSignal,
        body: serialized,
      });
    } catch {
      if (MUTATIONS.has(body.operation)) throw new BridgeError('WRITE_OUTCOME_UNKNOWN', 'The connection ended before confirmation. The operation may have been accepted. Check session history; retry a send only with the same requestId.');
      throw new BridgeError(signal?.aborted ? 'CANCELLED' : 'INSTANCE_OFFLINE', signal?.aborted ? 'The DSH request was cancelled.' : 'The DSH instance is offline or did not respond in time.');
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new BridgeError('AUTHENTICATION_FAILED', 'The DSH bridge refused this connection. Rediscover the running instance.');
    }
    let envelope;
    try { envelope = await boundedJson(response); } catch (error) {
      if (MUTATIONS.has(body.operation)) throw new BridgeError('WRITE_OUTCOME_UNKNOWN', 'The operation response could not be confirmed. Check session history; retry a send only with the same requestId.');
      throw error;
    }
    if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
      throw new BridgeError(MUTATIONS.has(body.operation) ? 'WRITE_OUTCOME_UNKNOWN' : 'INVALID_RESPONSE', 'The bridge returned an unsupported response.');
    }
    if (!envelope.ok) {
      const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'BRIDGE_FAILURE';
      const message = typeof envelope.error?.message === 'string' ? envelope.error.message : 'The DSH bridge refused the operation.';
      throw new BridgeError(redact(code, descriptor.token), redact(message, descriptor.token));
    }
    if (!response.ok) throw new BridgeError(MUTATIONS.has(body.operation) ? 'WRITE_OUTCOME_UNKNOWN' : 'HTTP_FAILURE', 'The DSH bridge returned an unsuccessful HTTP status.');
    return redact(envelope.data, descriptor.token);
  }
}
