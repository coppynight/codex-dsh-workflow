// Read-only reconciliation after a process has stopped; never sends a model prompt.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const [caseId,arm,runId='pilot-01']=process.argv.slice(2);
const dir=resolve('.local-runs/dsh-led',runId,caseId,arm);
const spec=JSON.parse(await readFile(join(dir,'spec.json'),'utf8'));
process.env.WORKFLOW_CONFIG=spec.workflowConfig;
const {readEvents,call}=await import('../../bridge/client.mjs');
const {readControl,assertNoPendingWork}=await import('../../bridge/control.mjs');
const {accountEvents}=await import('../../prototype/dsh-accounting.mjs');
const {dshCost}=await import('../../prototype/usage.mjs');
const file=join(dir,'capture/record.json'),r=JSON.parse(await readFile(file,'utf8'));
const list=await call('list',{}), control=await readControl();
const ids=new Set([r.sessionId]);let changed=true;
while(changed){changed=false;for(const row of list.items)if(ids.has(row.parentSessionId)&&!ids.has(row.sessionId)){ids.add(row.sessionId);changed=true;}}
for(const id of ids){if(list.items.find(row=>row.sessionId===id)?.running!==false)throw Error('Session is not idle');assertNoPendingWork(control,id);}
await copyFile(file,join(dir,'capture/record-before-accounting-reconciliation.json'),1);
r.descendants=[];r.usageEvents=[];
for(const id of ids){const data=await readEvents(id);const accounting=accountEvents(data.events);r.usageEvents.push(...accounting.usageEvents);
 if(id===r.sessionId)r.accounting=accounting;else r.descendants.push({sessionId:id,accounting});
 await writeFile(join(dir,'capture',id===r.sessionId?'private-reconciled-events.json':`private-reconciled-child-${id}.json`),JSON.stringify(data));
}
r.cost=dshCost(r);r.accountingReconciliation={at:new Date().toISOString(),readOnly:true,modelRerun:false,reason:'Use final post-cancel events, actual nested route and strict coverage gating; original retained'};
await writeFile(file,JSON.stringify(r,null,2));
const resultFile=join(dir,'result.json'),result=JSON.parse(await readFile(resultFile,'utf8'));
await copyFile(resultFile,join(dir,'result-before-accounting-reconciliation.json'),1);
result.cost=r.cost;result.accountingReconciliation=r.accountingReconciliation;
await writeFile(resultFile,JSON.stringify(result,null,2));
console.log(JSON.stringify({caseId,arm,cost:r.cost,coverage:r.accounting.coverageComplete,routes:r.accounting.routes,completed:r.completed}));
