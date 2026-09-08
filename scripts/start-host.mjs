// Internal launcher, called only under the recovery startup guard.
import { spawn } from 'node:child_process';
import { mkdir, open, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadConfig, isMain } from './config.mjs';
export async function startHost() {
const config=loadConfig(), dsh=config.dsh;
if(!dsh.autoStart) throw new Error('DSH autoStart is disabled. Review configuration and enable it for routine recovery.');
const entry=join(dsh.installDir,'node_modules/@deepseek-ai/dsh/lib/bin.js');
await stat(entry);
await mkdir(dsh.homeDir,{recursive:true,mode:0o700});
await mkdir(dirname(dsh.logPath),{recursive:true,mode:0o700});
await mkdir(dsh.stateDir,{recursive:true,mode:0o700});
const stdout=await open(dsh.logPath,'w',0o600), stderr=await open(join(dirname(dsh.logPath),'host.stderr.log'),'w',0o600);
try {
  const child=spawn(process.execPath,[entry,'web','--host',dsh.hostAddr,'--port',String(dsh.port),'--no-open'],{
    cwd:dsh.installDir,detached:true,windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd],env:{...process.env,DSH_HOME:dsh.homeDir}
  });
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
  const tmp=join(dsh.stateDir,`host.pid.${process.pid}.tmp`);
  await writeFile(tmp,String(child.pid)+'\n',{mode:0o600});await rename(tmp,join(dsh.stateDir,'host.pid'));
  return {started:true,pid:child.pid,origin:dsh.origin};
} finally {await stdout.close();await stderr.close();}
}
if(isMain(import.meta.url)) startHost().then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('DSH launcher failed; inspect runtime/configuration.');process.exitCode=2;});
