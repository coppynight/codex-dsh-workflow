import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { loadConfig, skillRoot } from '../scripts/config.mjs';
import { assertClaudeNetworkConfirmation } from '../scripts/network-gate.mjs';
import { runSubprocess, runRecovery, DEFAULTS } from '../scripts/dsh-recover.mjs';
import { install } from '../scripts/install.mjs';
import { collectReviewEvent, verifyReviewModel } from '../scripts/review-stream.mjs';
const execute=promisify(execFile);
async function temp(t) {const dir=await mkdtemp(join(tmpdir(),'portable-workflow-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('network gate rejects missing, no and nonliteral confirmations',()=>{
  for(const value of [undefined,null,false,'yes','no','uncertain',{},true]) assert.throws(()=>assertClaudeNetworkConfirmation(value),/CLAUDE_NETWORK_UNCONFIRMED/);
  assert.equal(assertClaudeNetworkConfirmation('stable-supported').source,'explicit-current-session-user-confirmation');
});
test('CLI refuses unconfirmed Claude before executable lookup or output creation',async t=>{
  const dir=await temp(t), packet=join(dir,'packet.md'), config=join(dir,'config.json'), out=join(dir,'output');
  await writeFile(packet,'Review this example.');
  await writeFile(config,JSON.stringify({claude:{executable:join(dir,'nonexistent-claude')}}));
  await assert.rejects(execute(process.execPath,[join(skillRoot,'scripts/claude-review.mjs'),'--cwd',dir,'--packet',packet,'--out',out],{env:{...process.env,WORKFLOW_CONFIG:config}}),error=>error.code===2 && error.stderr.includes('CLAUDE_NETWORK_UNCONFIRMED'));
  await assert.rejects(access(out),{code:'ENOENT'});
});
test('configuration is portable, rejects remote/token origins and unknown secret fields',async t=>{
  const dir=await temp(t), file=join(dir,'config.json');
  const config={version:1,dsh:{installDir:join(dir,'runtime'),stateDir:join(dir,'state'),workspaceRoots:[dir],origin:'http://127.0.0.1:3187',autoStart:true}};
  await writeFile(file,JSON.stringify(config));
  const loaded=loadConfig({WORKFLOW_CONFIG:file});
  assert.equal(loaded.dsh.port,3187);assert.equal(loaded.dsh.installDir,join(dir,'runtime'));assert.equal(loaded.dsh.autoStart,true);
  for(const origin of ['https://example.com','http://127.0.0.1:3187/?token=secret','http://user:secret@127.0.0.1:3187']) {
    await writeFile(file,JSON.stringify({dsh:{origin}}));assert.throws(()=>loadConfig({WORKFLOW_CONFIG:file}),/loopback|127.0.0.1/);
  }
  await writeFile(file,JSON.stringify({apiKey:'sentinel-secret'}));assert.throws(()=>loadConfig({WORKFLOW_CONFIG:file}),error=>!error.message.includes('sentinel-secret'));
  await writeFile(file,'bad json');assert.throws(()=>loadConfig({WORKFLOW_CONFIG:file}),/invalid JSON/);
  assert.throws(()=>loadConfig({WORKFLOW_CONFIG:join(dir,'missing.json')}),/missing/);
});
test('same source with trailing separators cannot be installed over itself',async()=>{
  await assert.rejects(install(skillRoot+'/',true),/outside the source/);
  await assert.rejects(install(join(skillRoot,'nested-skill'),false),/outside the source/);
});
test('installation copies runnable assets, refuses accidental overwrite, preserves update backup',async t=>{
  const dir=await temp(t), dest=join(dir,'skills','codex-dsh-workflow');
  const result=await install(dest);
  assert.equal(result.backup,null);await access(join(dest,'SKILL.md'));await access(join(dest,'bridge/server.mjs'));
  await writeFile(join(dest,'local-note.txt'),'preserve this');
  await assert.rejects(install(dest),/already exists/);
  const updated=await install(dest,true);
  assert.equal(await readFile(join(updated.backup,'local-note.txt'),'utf8'),'preserve this');
  // The backup is intentional user data and retained; only this test's identified backup is cleaned.
  t.after(()=>rm(updated.backup,{recursive:true,force:true}));
  await assert.rejects(access(join(dest,'local-note.txt')),{code:'ENOENT'});
});
test('POSIX probe timeout kills its own process group and destroys held pipes',async()=>{
  let group;
  const child=Object.assign(new EventEmitter(),{pid:987654321,stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null,kill:()=>true});
  const result=await runSubprocess('fake',[],{timeoutMs:10,platform:'linux',spawnImpl:()=>child,killImpl:(pid,signal)=>{group={pid,signal};}});
  assert.deepEqual(group,{pid:-987654321,signal:'SIGKILL'});assert.equal(result.timedOut,true);
  assert.equal(child.stdout.destroyed,true);assert.equal(child.stderr.destroyed,true);
});
test('review model evidence rejects a silently substituted or missing reviewer model',()=>{
  const state={reviewModels:new Set(),invalidLines:0,result:null};
  collectReviewEvent(state,JSON.stringify({type:'system',subtype:'init',model:'claude-opus-5'}));
  collectReviewEvent(state,JSON.stringify({type:'assistant',message:{model:'claude-opus-5',content:[]}}));
  assert.equal(verifyReviewModel(state,'claude-opus-5'),true);
  collectReviewEvent(state,JSON.stringify({type:'assistant',message:{model:'claude-other',content:[]}}));
  assert.equal(verifyReviewModel(state,'claude-opus-5'),false);
});
test('typed but corrupt cooldown state cannot trigger a service action',async t=>{
  const dir=await temp(t), file=join(dir,DEFAULTS.stateFile);
  const original=JSON.stringify({circuitOpen:true,circuitOpenUntilMs:String(Date.now()+300000),consecutiveHostFailures:3});
  await writeFile(file,original);let actions=0;
  const runtime={now:()=>Date.now(),sleep:async()=>{},isAlive:async()=>false,probeHost:async()=>{actions++;return {ok:false};},guardedStart:async()=>{actions++;return {ok:true,started:true};}};
  const result=await runRecovery(runtime,{stateDir:dir});
  assert.equal(result.status,'internal-error');assert.equal(actions,0);assert.equal(await readFile(file,'utf8'),original);
});
test('Windows process guard handles alternate Node installations and unreadable arguments',{skip:process.platform!=='win32'},async()=>{
  const powershell=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const {stdout}=await execute(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(skillRoot,'tests/host-process.windows.ps1')],{timeout:10000});
  assert.match(stdout,/guards passed/);
});
test('CLI transport forwards the exact custom configuration to the server',async t=>{
  const dir=await temp(t), file=join(dir,'custom-config.json');
  await writeFile(file,JSON.stringify({dsh:{workspaceRoots:[join(dir,'sentinel-workspace')],model:{provider:'sentinel-provider',model:'sentinel-model'}}}));
  const {stdout}=await execute(process.execPath,[join(skillRoot,'bridge/invoke.mjs'),'list'],{env:{...process.env,WORKFLOW_CONFIG:file},timeout:10000});
  const result=JSON.parse(stdout);
  assert.ok(result.tools.some(tool=>tool.name==='dsh_delegate' && tool.description.includes('sentinel-workspace')));
});
