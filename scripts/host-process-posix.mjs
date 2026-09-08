// Conservative Linux/macOS adapter. Unknown inspection state never permits start.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, unlink, mkdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config.mjs';
const execute=promisify(execFile), config=loadConfig(), dsh=config.dsh;
const entry=join(dsh.installDir,'node_modules/@deepseek-ai/dsh/lib/bin.js');
async function listening() {
  return new Promise((resolve,reject)=>{
    const socket=connect({host:dsh.hostAddr,port:dsh.port});
    socket.once('connect',()=>{socket.destroy();resolve(true);});
    socket.once('error',error=>{socket.destroy();if(error.code==='ECONNREFUSED')resolve(false);else reject(new Error('Port inspection unavailable.'));});
    socket.setTimeout(1500,()=>{socket.destroy();reject(new Error('Port inspection timed out.'));});
  });
}
async function inspect() {
  const {stdout}=await execute('ps',['-ww','-axo','pid=,args='],{timeout:5000,maxBuffer:4*1024*1024});
  if(!stdout.trim()) throw new Error('Process enumeration unavailable.');
  if(stdout.split('\n').some(line=>/^\s*\d+\s+\[?node\]?\s*$/.test(line))) throw new Error('Node command arguments are unavailable; Host absence cannot be proven.');
  // Any possible matching entry blocks a second launch, even when its port is unknown.
  const pids=stdout.split('\n').filter(line=>line.includes(entry)).map(line=>Number(line.trim().match(/^\d+/)?.[0])).filter(Number.isSafeInteger);
  const present=await listening();
  // TCP reachability alone cannot prove listener ownership. Fail closed if auth failed.
  return {ok:true,listener:{present,pids:[]},dsh:{present:pids.length>0,pids,primaryPid:pids[0]??null},ownsListener:false,foreignListener:present};
}
async function main() {
  let result=await inspect();
  if(process.argv.includes('--start-guard')) {
    result.startGuard={attempted:true,started:false,detail:'No start issued.'};
    const locks=join(homedir(),'.codex-dsh-workflow','host-start-locks');
    await mkdir(locks,{recursive:true,mode:0o700});
    const lock=join(locks,`127.0.0.1-${dsh.port}.lock`);
    let handle;
    try {
      handle=await open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid}));
      result={...await inspect(),startGuard:result.startGuard};
      if(!result.listener.present && !result.dsh.present && dsh.autoStart) {
        await (await import('./start-host.mjs')).startHost();result.startGuard.started=true;result.startGuard.detail='Started once under a local startup lock.';
      }
    } catch(error) {
      if(error.code==='EEXIST') result.startGuard.detail='Startup lock exists; inspect its owner before reclaiming it. No start issued.';
      else throw error;
    } finally {if(handle){await handle.close();await unlink(lock);}}
  }
  console.log(JSON.stringify(result));
}
main().catch(()=>{console.log(JSON.stringify({ok:false,error:'Process/port inspection or guarded start failed; no blind retry. See references/reliability.md.'}));process.exitCode=1;});
