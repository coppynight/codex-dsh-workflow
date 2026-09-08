import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {cases} from './cases.mjs';
import {nextCase} from './next-case.mjs';
import {rates,codexCost} from '../../prototype/usage.mjs';
import {studyBudget} from './budget.mjs';
const privateRoot=resolve('.local-runs/dsh-led'),out=resolve('examples/dsh-led-v5');
await mkdir(out,{recursive:true});
const hash=data=>createHash('sha256').update(data).digest('hex');
const sanitize=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value).replaceAll('D:\\\\workspace\\\\codex-dsh-workflow','<repo>').replaceAll('D:/workspace/codex-dsh-workflow','<repo>'));
const runs=[],baselineAcceptance=new Map();
for(const runId of ['pilot-01','pilot-low-01','pilot-compatible-01','pilot-feedback-01','pilot-next-01']){
 const phaseRoot=join(privateRoot,runId);const frozen=JSON.parse(await readFile(join(phaseRoot,'freeze.json'),'utf8'));
 // Public freezes keep hashes and text, but replace private absolute locations.
 await mkdir(join(out,runId),{recursive:true});await writeFile(join(out,runId,'freeze.json'),JSON.stringify(sanitize(frozen),null,2));
 for(const [id,data]of Object.entries(runId==='pilot-next-01'?{'durable-jobs':nextCase}:cases)){
  const base=join(phaseRoot,id),dest=join(out,runId,id);await mkdir(dest,{recursive:true});
  const acceptanceSha256=hash(await readFile(join(base,'acceptance.mjs')));
  const frozenCase=Array.isArray(frozen.cases)?frozen.cases.find(c=>c.id===id):frozen.cases?.[id]??frozen;
  let expectedAcceptance=frozenCase?.acceptanceSha256;
  if(runId==='pilot-01'&&id==='incremental-observation'){
   const erratum=JSON.parse(await readFile(join(phaseRoot,'erratum.json'),'utf8'));
   if(expectedAcceptance!==erratum.oldHash)throw Error('Erratum chain mismatch');expectedAcceptance=erratum.newHash;
  }
  if(runId==='pilot-low-01'){
   if(resolve(frozenCase.acceptanceSource)!==join(privateRoot,'pilot-01',id,'acceptance.mjs'))throw Error('Unexpected reused acceptance source');
   expectedAcceptance=baselineAcceptance.get(id);
  }
  if(acceptanceSha256!==expectedAcceptance)throw Error('Frozen acceptance mismatch: '+runId+'/'+id);
  if(runId==='pilot-01')baselineAcceptance.set(id,acceptanceSha256);
  await copyFile(join(base,'acceptance.mjs'),join(dest,'acceptance.mjs'));
  const initial=join(dest,'initial');await mkdir(initial,{recursive:true});
  for(const [name,source]of Object.entries({...data.files,'visible.test.mjs':data.visible,'package.json':'{"type":"module","private":true}'}))await writeFile(join(initial,name),source);
  for(const arm of ['astra','dsh-alone','dsh-advisor']){
   const dir=join(base,arm);let result;try{result=JSON.parse(await readFile(join(dir,'result.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
   const record=JSON.parse(await readFile(join(dir,'capture/record.json'),'utf8')),spec=JSON.parse(await readFile(join(dir,'spec.json'),'utf8'));
   const work=join(dest,arm,'work');await mkdir(work,{recursive:true});
   const sourceHashes={};
   for(const name of await readdir(spec.cwd)){if(!name.endsWith('.mjs')&&!['package.json','README.md'].includes(name))continue;const contents=await readFile(join(spec.cwd,name));sourceHashes[name]=hash(contents);await writeFile(join(work,name),contents);}
   const visibleTestsUnchanged=sourceHashes['visible.test.mjs']===hash(data.visible),packageUnchanged=sourceHashes['package.json']===hash('{"type":"module","private":true}');
   const consultations=(record.consultations??[]).map(c=>({status:c.status,question:c.decision?.question,context:c.decision?.context,cost:c.cost,elapsedMs:c.expert?.elapsedMs,protocolViolation:c.protocolViolation??null,toolCount:c.expert?.toolResults?.length??0}));
   const protocolValid=consultations.every(c=>c.status==='completed'&&!c.protocolViolation);
   const idleVerified=arm==='astra'?(record.cleanupVerified===true||(record.cleanupVerified===undefined&&record.exitCode===0&&!record.timedOut&&!record.launchError)):record.idleVerified===true;
   const completed=Boolean(result.completed&&!record.parseErrors&&!record.failures?.length);
   const costs=[result.cost,...consultations.map(c=>c.cost)];
   const row={id:`${runId}/${id}/${arm}`,runId,caseId:id,arm,effort:arm==='astra'?'medium':spec.reasoningEffort??'high',
    passed:result.passed,completed,idleVerified,visibleTestsUnchanged,packageUnchanged,protocolValid,
    autonomousSuccess:result.passed&&completed&&idleVerified&&visibleTestsUnchanged&&protocolValid,
    cleanupEvidence:arm==='astra'&&record.cleanupVerified===undefined?'Normal native CLI completion recorded; explicit cleanupVerified field was introduced later':undefined,
    executionElapsedMs:result.executionElapsedMs,totalMeasuredElapsedMs:result.elapsedMs,setupElapsedMs:spec.setupElapsedMs??null,
    executorCost:result.cost,totalApiEquivalentUsd:costs.every(c=>c?.complete)?costs.reduce((n,c)=>n+c.usd,0):null,
    consultations,approvalOrQuestionStop:record.error==='Executor needs user input; no automatic answer is authorized',
    error:result.error,sourceHashes,acceptanceSha256,promptSha256:hash(spec.task),requestedModel:record.requestedModel,
    modelEvidence:arm==='astra'?'Requested exact CLI model; actual route not present in JSONL':record.accounting?.routes,
    accountingCoverage:arm==='astra'?codexCost(record).complete:record.accountingFinalized,
    repairs:record.repairs??0,firstAcceptancePassed:record.verifications?.length?record.verifications[0].status==='passed':result.passed,
    acceptanceHistory:record.verifications?.map(v=>({status:v.status,exitCode:v.exitCode,stdout:sanitize(v.stdout),stderr:sanitize(v.stderr)}))??[],
    descendants:record.descendants?.length??0,acceptance:sanitize(result.acceptance),
    harnessProvenance:'Engineering harness evolved during exploration; see git history and STATE.md. Model tasks, source snapshots and corrections retained. Per-attempt runtime file hash was not captured for these early pilots.',
   };
   runs.push(row);
   await writeFile(join(dest,arm,'result.json'),JSON.stringify(sanitize(row),null,2));
   await writeFile(join(dest,arm,'task.md'),spec.task+'\n');
   if(arm!=='astra')await writeFile(join(dest,arm,'driver-prompts.json'),JSON.stringify(sanitize(record.requests.map(r=>({prompt:r.prompt,status:r.status}))),null,2));
  }
 }
}
for(const name of ['erratum.json','budget-clarification.json'])await writeFile(join(out,name),JSON.stringify(sanitize(JSON.parse(await readFile(join(privateRoot,'pilot-01',name),'utf8'))),null,2));
await copyFile(join(privateRoot,'pilot-01/incremental-observation/acceptance-before-erratum.mjs'),join(out,'acceptance-before-erratum.mjs'));
const old=JSON.parse(await readFile(join(privateRoot,'pilot-01/incremental-observation/astra/result-before-erratum.json'),'utf8'));
await writeFile(join(out,'astra-result-before-erratum.json'),JSON.stringify(sanitize(old),null,2));
const groups=[];for(const [runId,arm]of [['pilot-01','astra'],['pilot-01','dsh-alone'],['pilot-01','dsh-advisor'],['pilot-low-01','dsh-alone'],['pilot-low-01','dsh-advisor'],['pilot-compatible-01','dsh-advisor'],['pilot-feedback-01','dsh-advisor'],['pilot-next-01','astra'],['pilot-next-01','dsh-alone'],['pilot-next-01','dsh-advisor']]){
 const rows=runs.filter(r=>r.runId===runId&&r.arm===arm),baseline=runs.filter(r=>r.arm==='astra'&&rows.some(x=>x.caseId===r.caseId));
 const sum=(list,key)=>list.reduce((n,r)=>n+r[key],0);
 if(!rows.length)continue;
 const cost=rows.every(r=>r.totalApiEquivalentUsd!==null)?sum(rows,'totalApiEquivalentUsd'):null;
 const successful=rows.filter(r=>r.autonomousSuccess).length;
 const baselineKnown=baseline.length===rows.length&&baseline.every(r=>r.totalApiEquivalentUsd!==null)&&sum(baseline,'totalApiEquivalentUsd')>0;
 groups.push({runId,arm,attempts:rows.length,artifactPasses:rows.filter(r=>r.passed).length,autonomousSuccesses:successful,consultations:rows.reduce((n,r)=>n+r.consultations.length,0),
 firstAcceptancePasses:rows.filter(r=>r.firstAcceptancePassed).length,repairs:sum(rows,'repairs'),
 totalApiEquivalentUsd:cost,costRatio:cost===null||!baselineKnown?null:cost/sum(baseline,'totalApiEquivalentUsd'),executionTimeRatio:baseline.length?sum(rows,'executionElapsedMs')/sum(baseline,'executionElapsedMs'):null,
 costPerAutonomousSuccess:successful&&cost!==null?cost/successful:null,executionSeconds:sum(rows,'executionElapsedMs')/1000});
}
for(const name of ['freeze-before-clarification.json'])await copyFile(join(privateRoot,'pilot-next-01',name),join(out,'pilot-next-01',name));
await copyFile(join(privateRoot,'pilot-next-01/acceptance-before-clarification.mjs'),join(out,'pilot-next-01/durable-jobs/acceptance-before-clarification.mjs'));
await mkdir(join(out,'pilot-pro-01'),{recursive:true});
await copyFile(join(privateRoot,'pilot-pro-01/freeze.json'),join(out,'pilot-pro-01/freeze-not-executed.json'));
const summary={version:1,generatedAt:new Date().toISOString(),uniqueTasks:new Set(runs.map(r=>r.caseId)).size,attempts:runs.length,rates,
 studyStop:'Fourth native task ended after transport retries. Complete retry cost remains unknown. Read-only acceptance failed; no planned repair, remaining DSH arms or prepared Pro trial submitted. No matched fourth-task comparison exists.',
 costBasis:'Frozen standard Astra API-equivalent and peak DeepSeek rates. Actual subscription quota and invoice cost not measured. R&D/root coordination not allocated.',
 interpretation:'Small component pilots and known-case configuration ablations. No universal 90% capability, 10x account or expert causal-benefit claim.',
 taskCodeInterventions:0,harnessDevelopmentInterventions:'Occurred during study, not quantitatively measured. Autonomous-success label describes a task run, not a proven zero-maintenance product.',groups,runs};
const budget=await studyBudget();
summary.studyCost={complete:budget.complete,observedApiEquivalentUsd:budget.totalUsd,deepseekPeakEquivalentUsd:budget.deepseekUsd,unknownAttempts:budget.unknown.map(p=>p.replaceAll('\\','/').split('/dsh-led/')[1]),includes:'All submitted task attempts, repairs and two capability probes; excludes unallocated R&D/root work. Observed cost is not a complete final bill.'};
const nativeProbe=JSON.parse(await readFile(join(privateRoot,'native-probe-01/capture/record.json'),'utf8'));
const mcpProbe=JSON.parse(await readFile(join(privateRoot,'mcp-probe-01/ledger/probe-one.json'),'utf8'));
const probeResults=JSON.parse(await readFile(join(privateRoot,'mcp-probe-01/result.json'),'utf8'));
await writeFile(join(out,'probes.json'),JSON.stringify({notTaskPerformance:true,native:{requestedModel:nativeProbe.requestedModel,exitCode:nativeProbe.exitCode,elapsedMs:nativeProbe.elapsedMs,cost:codexCost(nativeProbe),toolEvents:nativeProbe.toolResults.length},mcp:{question:mcpProbe.decision.question,context:mcpProbe.decision.context,cost:mcpProbe.cost,elapsedMs:mcpProbe.expert.elapsedMs,toolEvents:mcpProbe.expert.toolResults.length,first:JSON.parse(probeResults.first.content[0].text),replay:JSON.parse(probeResults.repeated.content[0].text),nextId:JSON.parse(probeResults.denied.content[0].text)}},null,2));
await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2));
await writeFile(resolve('site/dsh-led-data.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({attempts:runs.length,groups},null,2));
