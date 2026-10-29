#!/usr/bin/env node
import { main } from '../src/mcp.js';
main().catch(error => {
  process.stderr.write(`dsh-codex-bridge: ${error.message}\n`);
  process.exitCode = 1;
});
