import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stopOwnedHost } from './owned-host.mjs';
import {verifyCommand} from './verify.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const [command,inputFile]=process.argv.slice(2);
const print=value=>console.log(JSON.stringify(value,null,2));
const childRun=(args,options={})=>new Promise((done,fail)=>{
  const child=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:'inherit',...options});
  child.on('error',fail);child.on('close',code=>code===0?done():fail(Error(`Setup exited ${code}; inspect the saved run before retrying`)));
});

if(command==='inspect' && inputFile) {
  const spec=JSON.parse(await readFile(resolve(inputFile),'utf8'));
  let record;
  try {
    record=JSON.parse(await readFile(join(spec.outputDir,'record.json'),'utf8'));
    const saved=await readFile(join(dirname(resolve(inputFile)),'summary.json'),'utf8').then(JSON.parse).catch(()=>null);
    if(saved?.hostCleanup?.stopped){print({...saved,liveStatus:'owned Host was stopped after idle verification',readOnly:true});}
    else {
    if(!spec.workflowConfig)throw Error('Host configuration was not recorded');
    process.env.WORKFLOW_CONFIG=spec.workflowConfig;
    const {inspectSession}=await import('./runner.mjs');
    const {state}=await inspectSession(record.sessionId,record.requestId);
    print({sessionId:record.sessionId,requestId:record.requestId,state:state.state,pendingApprovals:state.pendingApprovalCount,pendingQuestions:state.pendingQuestionCount,recordPhase:record.phase,cost:record.cost,
      recovery:'Inspection does not submit another paid request. For an interrupted or unknown run, inspect its saved IDs and processes before starting a replacement in this workspace.'});
    }
  } catch { print({phase:record?.phase??'setup-or-unrecorded',cost:record?.cost??null,liveStatus:'unavailable',recovery:'Check the saved spec and setup summary. If a request was submitted, inspect its recorded IDs and private Host log; do not resubmit an ambiguous request.'});process.exitCode=2; }
} else if(command==='run' && inputFile) {
  const inputPath=resolve(inputFile),input=JSON.parse(await readFile(inputPath,'utf8'));
  const cwd=resolve(dirname(inputPath),input.cwd ?? '.');
  if(!(await stat(cwd)).isDirectory())throw Error('cwd must be an existing workspace');
  const task=input.task ?? await readFile(resolve(dirname(inputPath),input.taskFile),'utf8');
  if(typeof task!=='string'||!task.trim())throw Error('Provide task or taskFile');
  if(input.verify && (!Array.isArray(input.verify)||!input.verify.length||input.verify.some(x=>typeof x!=='string'||!x)))throw Error('verify must be an executable-and-arguments array');
  const id='task-'+randomUUID();
  const base=join(process.env.LOCALAPPDATA||join(homedir(),'.local'),'dsh-led-private','runs',id);
  await mkdir(base,{recursive:true,mode:0o700});
  const specFile=join(base,'spec.json');
  const spec={cwd,task,advisor:input.advisor!==false,model:input.model??'deepseek-v4-flash',reasoningEffort:input.reasoningEffort??'high',privateId:id,outputDir:join(base,'capture')};
  await writeFile(specFile,JSON.stringify(spec,null,2),{flag:'wx'});
  print({run:id,specFile,phase:'setup',message:'DSH drives the task. Astra is an optional bounded advisor. Keep this path to inspect an interruption.'});
  let record,setup;
  const started=Date.now();
  try {
    await childRun([join(root,'prototype/isolated-host.mjs'),specFile]);
    setup=JSON.parse(await readFile(specFile,'utf8'));process.env.WORKFLOW_CONFIG=setup.workflowConfig;
    const {releaseWorkspaceClaim}=await import('./workspace.mjs');
    const {runDsh}=await import('./runner.mjs');
    record=await runDsh({...setup,retainWorkspaceClaim:true,maxRepairs:input.verify?1:0,verify:input.verify?()=>verifyCommand(input.verify,cwd):undefined,onProgress:value=>console.log(JSON.stringify(value))});
    const verification=record.verifications.at(-1)??{status:input.verify?'not-run':'not-configured'};
    if(verification.cleanupVerified===false)record.idleVerified=false;
    if(record.idleVerified && record.workspaceClaim==='held'){
      await releaseWorkspaceClaim({stateDir:setup.workspaceRegistry,cwd:record.cwd,taskId:`dsh-led-${record.sessionId}`,sessionId:record.sessionId});
      record.workspaceClaim='released';
    }
    await writeFile(join(setup.outputDir,'record.json'),JSON.stringify(record,null,2));
    const consultations=record.consultations.map(c=>({status:c.status,cost:c.cost}));
    const parts=[record.cost,...consultations.map(c=>c.cost)];
    const completeCost=parts.every(c=>c?.complete);
    const summary={run:id,specFile,status:record.phase==='verification-failed'?'verification-failed':record.completed&&record.idleVerified?(verification.status==='passed'?'verified':verification.status==='not-configured'?'model-completed-unverified':'verification-failed'):'stopped',
      verification,repairs:record.repairs,elapsedMs:Date.now()-started,modelCompleted:record.completed,idleVerified:record.idleVerified,
      executorCost:record.cost,consultations,totalApiEquivalentUsd:completeCost?parts.reduce((n,c)=>n+c.usd,0):null,error:record.error??null};
    if(record.idleVerified)summary.hostCleanup=await stopOwnedHost(setup);
    await writeFile(join(base,'summary.json'),JSON.stringify(summary,null,2));print(summary);
    if(summary.status!=='verified'&&summary.status!=='model-completed-unverified')process.exitCode=2;
  } catch(error) {
    const summary={run:id,specFile,status:'stopped',error:error.message,recovery:'No automatic resubmission. Check setup/credentials with npm run doctor, or inspect this saved spec if a session was submitted.'};
    await writeFile(join(base,'summary.json'),JSON.stringify(summary,null,2));print(summary);process.exitCode=2;
  }
} else {
  console.log('Usage: node prototype/task.mjs run TASK.json | inspect SAVED_SPEC.json');
  console.log('TASK.json: {"cwd":"../project","taskFile":"task.md","verify":["node","--test"],"advisor":true,"reasoningEffort":"high"}');
}
