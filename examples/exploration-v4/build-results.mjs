import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {astraCost,dshCost} from '../budget-v3/cost.mjs';
import {sourceFiles} from '../budget-v3/case.mjs';
const [root]=process.argv.slice(2);if(!isAbsolute(root||''))throw Error('Absolute root required');
const read=async p=>JSON.parse(await readFile(p,'utf8')),pub=new URL('./results/',import.meta.url);await mkdir(pub,{recursive:true});
const plan=await read(new URL('../budget-v3/results/plan-record.json',import.meta.url)),prior=await read(new URL('../budget-v3/results/summary.json',import.meta.url));
await copyFile(join(root,'freeze.json'),new URL('freeze.json',pub));
const variants=[];
for(const id of ['original-low','bounded-high','bounded-low']){
 const dir=join(root,id),dest=new URL(id+'/',pub);await mkdir(dest,{recursive:true});
 for(const file of ['dsh-record.json','review-record.json','review-prompt.txt','review-visible.json','acceptance.json','diagnostic.json'])await copyFile(join(dir,file),new URL(file,dest));
 const request=await read(join(dir,'request.json'));await writeFile(new URL('implement-prompt.txt',dest),request.prompt);
 for(const file of sourceFiles)await copyFile(join(dir,'work',file),new URL(file,dest));
 const dsh=await read(join(dir,'dsh-record.json')),review=await read(join(dir,'review-record.json')),acceptance=await read(join(dir,'acceptance.json')),diagnostic=await read(join(dir,'diagnostic.json'));
 const full=await read(join(dir,'private-state.json'));
 await writeFile(new URL('executor-final-report.json',dest),JSON.stringify(full.messages.at(-1),null,2));
 const start=dsh.turnEvents.find(e=>e.type==='turn/start').time,end=dsh.turnEvents.findLast(e=>e.type==='turn/end').time;
 const isPeak=t=>{const d=new Date(t),h=d.getUTCHours();return d.getUTCDay()>=1&&d.getUTCDay()<=5&&((h>=1&&h<4)||(h>=6&&h<10));};if(![start,end,...dsh.usageEvents.map(e=>e.time)].every(isPeak))throw Error('Price per event before publishing mixed window');
 const cost=dshCost(dsh.usageEvents,true),astra=astraCost(plan.usageEvents)+astraCost(review.usageEvents);
 const confirmedDefects=Number(diagnostic.errorMessageLeaksPathMarker)+Number(diagnostic.collision.deletedUnownedTemp);
 const visibleUnchanged=createHash('sha256').update(await readFile(join(dir,'work','visible-test.mjs'))).digest('hex')===createHash('sha256').update(await readFile(new URL('../budget-v3/fixture/visible-test.mjs',import.meta.url))).digest('hex');
 variants.push({id,selectedModel:dsh.selectedModel,state:dsh.state,deadlineCancelled:dsh.deadlineCancelled,executionMs:end-start,executionUSD:cost,astraPlanAndReviewUSD:astra,measuredStageTotalUSD:astra+cost,measuredStageElapsedMs:plan.elapsedMs+review.elapsedMs+end-start,toolCalls:dsh.toolCalls.length,visibleUnchanged,frozenAcceptance:JSON.parse(acceptance.stdout),initialAstraVerdict:review.answer.verdict,reviewFindings:review.answer.findings,postHocAdjudication:{disprovedRegexFinding:!diagnostic.reviewRegexFindingConfirmed,confirmedDefects,eligibleForFurtherDeliveryReview:confirmedDefects===0,notes:'Root independently ran post-hoc diagnostics. No code repair. Initial review verdict preserved; adjudication model overhead unmeasured.'},recordedHumanRequests:dsh.approvalRequests.length+dsh.questionRequests.length,processDeviation:id==='original-low'?'Executor reports extra temporary test artifacts outside explicitly listed source paths.':null});
}
for(const id of ['a','b'])await copyFile(join(root,'v3-'+id+'-diagnostic.json'),new URL('v3-'+id+'-diagnostic.json',pub));
const summary={date:'2026-09-08',kind:'exploratory ablation, one task per variant',historicalControls:{astra:prior.a,originalHigh:prior.b},variants,scope:'DSH variants ran concurrently on same service; historical controls are not concurrent repeats. Shared measured Astra plan reused. Native tool-free Astra baseline remains limited. All parent coordination/adjudication/setup costs excluded; no complete throughput or intervention reduction claim.',keyFinding:'Bounding execution and verification scope matters; fastest low-effort variant has two confirmed defects, while all three model reviews repeat a disproved JavaScript regex finding.',recordedNewExperimentAPIEquivalentUSD:variants.reduce((s,v)=>s+v.executionUSD+v.astraPlanAndReviewUSD-astraCost(plan.usageEvents),0),recommendedDirection:'Budgeted, evidence-backed background delivery of task families; candidate direction, not implemented batch product.',notMeasured:['Native low-price executor baseline','Real backlog batch throughput','End-to-end parent quota/cost','User active minutes saved','Repeated-run quality and latency']};
await writeFile(new URL('summary.json',pub),JSON.stringify(summary,null,2));console.log(JSON.stringify(variants.map(v=>({id:v.id,seconds:v.executionMs/1000,totalUSD:v.measuredStageTotalUSD,confirmedDefects:v.postHocAdjudication.confirmedDefects}))));
