// Read-only reconciliation after a process has stopped; never sends a model prompt.
import { readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const [caseId,arm,runId='pilot-01']=process.argv.slice(2);
const dir=resolve('.local-runs/dsh-led',runId,caseId,arm);
const spec=JSON.parse(await readFile(join(dir,'spec.json'),'utf8'));
process.env.WORKFLOW_CONFIG=spec.workflowConfig;
const {readEvents,call}=await import('../../bridge/client.mjs');
const {readControl,assertNoPendingWork}=await import('../../bridge/control.mjs');
const {accountEvents}=await import('../../prototype/dsh-accounting.mjs');
const {dshCost,codexCost}=await import('../../prototype/usage.mjs');
const {sessionAddress}=await import('../../prototype/session-address.mjs');
const file=join(dir,'capture/record.json'),r=JSON.parse(await readFile(file,'utf8'));
const list=await call('list',{}), control=await readControl();
const ids=new Set([r.sessionId]);let changed=true;
while(changed){changed=false;for(const row of list.items)if(ids.has(row.parentSessionId)&&!ids.has(row.sessionId)){ids.add(row.sessionId);changed=true;}}
for(const id of ids){if(list.items.find(row=>row.sessionId===id)?.running!==false)throw Error('Session is not idle');assertNoPendingWork(control,id);}
await copyFile(file,join(dir,'capture/record-before-accounting-reconciliation-v2.json'),1);
r.descendants=[];r.usageEvents=[];
for(const id of ids){const data=await readEvents(sessionAddress(list.items.find(row=>row.sessionId===id)));const accounting=accountEvents(data.events,data.header?.seedLength??0);r.usageEvents.push(...accounting.usageEvents);
 if(id===r.sessionId)r.accounting=accounting;else r.descendants.push({sessionId:id,accounting});
 await writeFile(join(dir,'capture',id===r.sessionId?'private-reconciled-events.json':`private-reconciled-child-${id}.json`),JSON.stringify(data));
}
r.cost=dshCost(r);
if(spec.nativeMcp){
 const names=await readdir(spec.advisorLedgerDir);if(names.includes('active.lock'))throw Error('Advisor operation may still be active');
 r.consultations=[];for(const name of names.filter(n=>n.endsWith('.json'))){const c=JSON.parse(await readFile(join(spec.advisorLedgerDir,name),'utf8'));if(!c.expert?.cleanupVerified)throw Error('Advisor exit unknown');c.cost=codexCost(c.expert);r.consultations.push(c);}
 r.advisorLedgerDir=spec.advisorLedgerDir;
}
r.accountingFinalized=Boolean(r.cost.complete&&r.consultations.every(c=>c.cost?.complete));
r.accountingReconciliation={at:new Date().toISOString(),readOnly:true,modelRerun:false,reason:'Use final post-cancel events, nested route, strict coverage and native advisor ledger; original retained'};
await writeFile(file,JSON.stringify(r,null,2));
const resultFile=join(dir,'result.json'),result=JSON.parse(await readFile(resultFile,'utf8'));
await copyFile(resultFile,join(dir,'result-before-accounting-reconciliation-v2.json'),1);
result.cost=r.cost;result.accountingReconciliation=r.accountingReconciliation;
await writeFile(resultFile,JSON.stringify(result,null,2));
console.log(JSON.stringify({caseId,arm,cost:r.cost,coverage:r.accounting.coverageComplete,routes:r.accounting.routes,completed:r.completed}));
