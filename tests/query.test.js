import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,chmod,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';

test('read-only query works through an installed skill symlink from another workspace',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dsh-query-'));
  const registry=join(directory,'instances');
  await mkdir(registry,{mode:0o700});
  const token='fixture-bridge-token-never-displayed-in-cli';
  const calls=[];
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${token}`);
    let text='';for await(const chunk of req)text+=chunk;
    calls.push(JSON.parse(text));
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ok:true,data:{source:'dsh-runtime',observedAtText:'2026-10-29 21:00:00',
      timeZone:'Asia/Shanghai',sessions:[{sessionId:'continued',title:'Existing conversation',
        cwd:'/work/code-agents',lastConversationTime:'2026-10-29 20:00:00',
        lastReply:{text:'Today result'},lastEnd:{reason:{kind:'completed'}}}],hasMore:false}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  await writeFile(join(registry,'fixture.json'),JSON.stringify({schemaVersion:1,instanceId:'fixture',
    endpoint:`http://127.0.0.1:${server.address().port}/codex-bridge/v1`,token,pid:process.pid,
    startedAt:Date.now(),profile:'test',readOnly:true}),{mode:0o600});
  const skill=join(directory,'installed-skill');
  await symlink(resolve('skills/dsh-sessions'),skill,'dir');
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});});
  async function run(args){
    const child=spawn(process.execPath,[join(skill,'scripts/query.mjs'),...args],{
      cwd:tmpdir(),env:{...process.env,DSH_BRIDGE_DIR:registry},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
    const [code]=await once(child,'exit');assert.equal(code,0,stderr);
    assert.equal((stdout+stderr).includes(token),false);return stdout;
  }
  const json=JSON.parse(await run(['recent','--workspace','code-agents','--json']));
  assert.equal(json.sessions[0].sessionId,'continued');
  assert.deepEqual(calls[0],{workspace:'code-agents',operation:'recent'});
  const table=await run(['recent','--workspace','code-agents']);
  assert.match(table,/\| 最近对话时间 \|/);
  assert.match(table,/2026-10-29 20:00:00/);
  assert.match(table,/Today result/);
});
