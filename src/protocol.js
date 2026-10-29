/** Shared wire constants. Credentials in discovery files never enter tool results. */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROTOCOL_VERSION = 1;
export const ROUTE = '/codex-bridge/v1';
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_WAIT_MS = 45_000;

/** Resolve the explicitly configured discovery directory, then the DSH home default. */
export function discoveryDirectory(env = process.env) {
  return env.DSH_BRIDGE_DIR || join(env.DSH_HOME || join(homedir(), '.dsh'), 'bridges', 'instances');
}
