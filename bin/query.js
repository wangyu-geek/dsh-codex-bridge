#!/usr/bin/env node
/** Read-only CLI fallback for Codex surfaces that have not loaded local MCP tools. */
import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import { BridgeClient } from '../src/client.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  workspace: { type: 'string' }, query: { type: 'string' }, instance: { type: 'string' },
  session: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' },
  json: { type: 'boolean' }, 'include-subagents': { type: 'boolean' },
} });
const operation = positionals[0] ?? 'recent';
if (!['recent', 'instances', 'sessions', 'status', 'read'].includes(operation) || positionals.length > 1) {
  process.stderr.write('Usage: query.js [recent|instances|sessions|status|read] [--workspace NAME] [--query TEXT] [--session ID] [--instance ID] [--limit N] [--offset N] [--json]\n');
  process.exitCode = 1;
} else {
  try {
    const args = {};
    for (const [flag, key] of [['instance','instanceId'],['session','sessionId'],['workspace','workspace'],['query','query']]) {
      if (values[flag] !== undefined) args[key] = values[flag];
    }
    for (const field of ['limit','offset']) {
      if (values[field] !== undefined) {
        args[field] = Number(values[field]);
        if (!Number.isSafeInteger(args[field])) throw new Error(`${field} must be an integer`);
      }
    }
    if (values['include-subagents']) args.includeSubagents = true;
    const client = new BridgeClient();
    const result = operation === 'instances' ? await client.instances() : (await client.request(operation, args)).data;
    if (values.json || operation !== 'recent') {
      process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
    } else {
      const cell = value => String(value ?? '—').replaceAll('|','\\|').replace(/[\r\n]+/g,' ').slice(0,220);
      process.stdout.write(`数据来源：DSH runtime；查询时间：${result.observedAtText} (${result.timeZone})\n\n`);
      process.stdout.write('| 最近对话时间 | 会话 | 工作区 | 状态 | 最近结果 |\n|---|---|---|---|---|\n');
      const artifacts=[];
      for (const row of result.sessions) {
        const state = row.running ? row.activity : row.lastEnd?.reason?.kind === 'completed' ? '本轮正常结束' : row.activity;
        const reply = row.lastReply?.text || row.resultError?.message || '暂无可见回复';
        process.stdout.write(`| ${cell(row.lastConversationTime)} | ${cell(row.title || row.sessionId)} | ${cell(basename(row.cwd || ''))} | ${cell(state)} | ${cell(reply)} |\n`);
        artifacts.push(...row.artifacts ?? []);
      }
      for (const artifact of artifacts) process.stdout.write(`\n产物：${cell(artifact.path)}\n`);
      if (!result.sessions.length) process.stdout.write('\n没有匹配的 DSH 会话。\n');
      if (result.hasMore) process.stdout.write(`\n更多会话：--offset ${result.nextOffset}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.code ?? 'QUERY_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
