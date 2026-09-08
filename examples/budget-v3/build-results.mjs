import {readFile,writeFile,copyFile,mkdir,access} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {astraCost,astraCredits,dshCost} from './cost.mjs';
import {sourceFiles} from './case.mjs';
const [root]=process.argv.slice(2);if(!isAbsolute(root||''))throw Error('Absolute private run root required');
const here=new URL('./',import.meta.url),read=async p=>JSON.parse(await readFile(p,'utf8'));
const plan=await read(join(root,'plan','plan-record.json'));
const interventions=await read(new URL('./results/interventions.json',here));
const pub=new URL('./results/',here);await mkdir(pub,{recursive:true});
await copyFile(join(root,'freeze.json'),new URL('freeze.json',pub));
await copyFile(join(root,'plan','plan-record.json'),new URL('plan-record.json',pub));
await copyFile(join(root,'plan','plan-prompt.txt'),new URL('plan-prompt.txt',pub));
const outputs={};
for(const arm of ['a','b']){
 const dest=new URL(arm+'/',pub);await mkdir(dest,{recursive:true});
 const stages=[];
 for(const stage of ['implement','review','repair','rereview']){
  const file=join(root,arm,stage+'-record.json');try{await access(file);}catch{continue;}
  const record=await read(file);if(record.exitCode!==0||record.toolItems.length||!record.usageEvents.length)throw Error('Unsuccessful or tool-using Astra stage');
  await copyFile(file,new URL(stage+'-record.json',dest));await copyFile(join(root,arm,stage+'-prompt.txt'),new URL(stage+'-prompt.txt',dest));
  stages.push({stage,model:'gpt-6-astra',elapsedMs:record.elapsedMs,usd:astraCost(record.usageEvents),credits:astraCredits(record.usageEvents)});
 }
 for(const file of sourceFiles)await copyFile(join(root,arm,'work',file),new URL(file,dest));
 const acceptance=await read(join(root,arm,'acceptance.json'));await copyFile(join(root,arm,'acceptance.json'),new URL('acceptance.json',dest));
 await copyFile(join(root,arm,'review-visible.json'),new URL('review-visible.json',dest));
 const lastReview=await read(join(root,arm,stages.some(s=>s.stage==='rereview')?'rereview-record.json':'review-record.json'));
 const score=JSON.parse(acceptance.stdout);
 const stagePlan={stage:'shared-plan',model:'gpt-6-astra',elapsedMs:plan.elapsedMs,usd:astraCost(plan.usageEvents),credits:astraCredits(plan.usageEvents)};
 const astraUSD=stagePlan.usd+stages.reduce((s,x)=>s+x.usd,0),credits=stagePlan.credits+stages.reduce((s,x)=>s+x.credits,0);
 let dshUSD=0,dshElapsed=0;
 if(arm==='b'){
  const dsh=await read(join(root,arm,'dsh-record.json'));const start=dsh.turnEvents.find(e=>e.type==='turn/start'),end=dsh.turnEvents.findLast(e=>e.type==='turn/end');
  if(!start||!end)throw Error('Missing DSH stage timing');
  const peak=t=>{const d=new Date(t),h=d.getUTCHours();return d.getUTCDay()>0&&d.getUTCDay()<6&&((h>=1&&h<4)||(h>=6&&h<10));};
  if(!dsh.usageEvents.every(e=>peak(e.time))||!peak(start.time)||!peak(end.time))throw Error('Mixed price window: price per event before continuing');
  dshUSD=dshCost(dsh.usageEvents,true);dshElapsed=end.time-start.time;
  await copyFile(join(root,arm,'dsh-record.json'),new URL('dsh-record.json',dest));
  const request=await read(join(root,'b-request.json'));await writeFile(new URL('implement-prompt.txt',dest),request.prompt);
  stages.unshift({stage:'implement+self-test',model:'deepseek-v4-flash',usd:dshUSD,elapsedMs:dshElapsed});
 }
 outputs[arm]={artifactAccepted:score.passed===score.total&&acceptance.exitCode===0&&lastReview.answer.verdict==='accept'&&lastReview.answer.findings.length===0,processContractCompliant:arm==='a',acceptance:score,astraUSD,dshUSD,totalUSD:astraUSD+dshUSD,codexCreditEquivalent:credits,elapsedMs:stagePlan.elapsedMs+stages.reduce((s,x)=>s+x.elapsedMs,0),humanRequests:interventions[arm].requiredHumanRequests,humanActions:interventions[arm].actualHumanActions,humanMinutes:interventions[arm].humanMinutes,stages:[stagePlan,...stages]};
}
const previous=await read(new URL('../results/paired.json',here));let oldA=0,oldB=0,oldDSH=0;
for(const c of previous.cases){oldA+=astraCost([{usage:c.astra.usage}]);oldB+=astraCost([{usage:c.workflow.usage}]);const d=await read(new URL('../results/'+c.id+'/dsh-usage.json',here));oldDSH+=dshCost(d.usageEvents,false);}
const result={date:'2026-09-08',case:'job-report-cli',samplePairs:1,scope:'Measured model planning/implementation/acceptance only. Astra tool-free; DSH normal tools. Parent orchestration/setup/publication and DSH auxiliary title generation excluded.',...outputs,astraReductionPct:(1-outputs.b.astraUSD/outputs.a.astraUSD)*100,totalReductionPct:(1-outputs.b.totalUSD/outputs.a.totalUSD)*100,weightedAstraCapacityRatio:outputs.a.astraUSD/outputs.b.astraUSD,observedSubscriptionCapacityRatio:null,humanReductionPct:null,recordedExperimentModelAPIEquivalentUSD:outputs.a.totalUSD+outputs.b.totalUSD-astraCost(plan.usageEvents),sharedPlanNote:'Charged to both counterfactual arms, only once in actual experiment spend.',oldV2Repriced:{astraUSD:oldA,workflowAstraUSD:oldB,workflowDSHOffPeakUSD:oldDSH,workflowTotalUSD:oldB+oldDSH,totalIncreasePct:((oldB+oldDSH)/oldA-1)*100}};
await writeFile(new URL('summary.json',pub),JSON.stringify(result,null,2)+'\n');await copyFile(new URL('summary.json',pub),new URL('../../site/data/budget.json',here));console.log(JSON.stringify(result,null,2));
