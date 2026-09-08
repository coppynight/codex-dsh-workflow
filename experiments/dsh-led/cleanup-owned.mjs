// Run only after the study has stopped. Read live native state before every kill.
import {readFile,readdir,writeFile,access}from 'node:fs/promises';
import {resolve,join,dirname}from 'node:path';
import {spawn}from 'node:child_process';
import {fileURLToPath}from 'node:url';
const [file]=process.argv.slice(2);
if(file){
 const spec=JSON.parse(await readFile(resolve(file),'utf8'));
 const record=JSON.parse(await readFile(join(spec.outputDir,'record.json'),'utf8'));
 if(!record.idleVerified||!record.accountingFinalized)throw Error('Saved final state is not known idle and accounted');
 process.env.WORKFLOW_CONFIG=spec.workflowConfig;
 const {call}=await import('../../bridge/client.mjs');
 const {readControl,assertNoPendingWork}=await import('../../bridge/control.mjs');
 const list=await call('list',{}),control=await readControl(),ids=new Set([record.sessionId]);
 let changed=true;while(changed){changed=false;for(const row of list.items)if(ids.has(row.parentSessionId)&&!ids.has(row.sessionId)){ids.add(row.sessionId);changed=true;}}
 for(const id of ids){if(list.items.find(r=>r.sessionId===id)?.running!==false)throw Error('Native writer is not idle');assertNoPendingWork(control,id);}
 if(spec.advisorLedgerDir){try{await access(join(spec.advisorLedgerDir,'active.lock'));throw Error('Advisor lock remains');}catch(e){if(e.code!=='ENOENT')throw e;}}
 const {stopOwnedHost}=await import('../../prototype/owned-host.mjs');
 console.log(JSON.stringify({case:dirname(file).replaceAll('\\','/').split('/dsh-led/')[1],...(await stopOwnedHost(spec))}));
}else{
 const root=resolve('.local-runs/dsh-led'),specs=[];
 async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.name==='spec.json'){const s=JSON.parse(await readFile(p,'utf8'));if(s.workflowConfig&&s.privateRoot&&s.hostPid)specs.push(p);}}}
 await walk(root);const results=[];
 for(const spec of specs){const result=await new Promise(done=>{const c=spawn(process.execPath,[fileURLToPath(import.meta.url),spec],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';c.stdout.setEncoding('utf8');c.stderr.setEncoding('utf8');c.stdout.on('data',d=>stdout+=d);c.stderr.on('data',d=>stderr+=d);c.on('error',e=>done({exit:null,error:e.code}));c.on('close',exit=>done({exit,stdout,stderr}));});results.push(result);console.log(result.exit===0?result.stdout:JSON.stringify({stopped:false,spec,error:result.stderr}));}
 await writeFile(join(root,'cleanup-result.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));
 if(results.some(r=>r.exit!==0||!JSON.parse(r.stdout).stopped))process.exitCode=1;
}
