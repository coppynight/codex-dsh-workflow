import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, basename, dirname } from 'node:path';
import { codexCost, dshCost, incompleteCost } from '../../prototype/usage.mjs';
export async function studyBudget() {
 const root=resolve('.local-runs/dsh-led'), rows=[];
 async function walk(path){const entries=await readdir(path,{withFileTypes:true});
 if(basename(path)==='capture' && !entries.some(e=>e.name==='record.json') && entries.some(e=>['attempt.json','prompt.txt','process.json','owner.json'].includes(e.name))) rows.push({path,cost:null,kind:'unknown',phase:'started-without-final-record'});
 for(const e of entries){const next=join(path,e.name);if(e.isDirectory())await walk(next);else if(e.name==='record.json'&&basename(dirname(next))==='capture'){
  const r=JSON.parse(await readFile(next,'utf8'));let cost=r.role==='executor'?codexCost(r):dshCost(r);
  if(r.role!=='executor'&&!r.accountingFinalized)cost=incompleteCost(cost,'final accounting, including advisor ledger, is not committed');
  rows.push({path,cost,kind:r.role,phase:r.phase??'finished'});
  for(const c of r.consultations??[])rows.push({path:path+'/consult/'+(c.consultationId??c.index),cost:c.expert?codexCost(c.expert):null,kind:'advisor'});
 }}}
 await walk(root);
 try{const p=JSON.parse(await readFile(join(root,'mcp-probe-01/ledger/probe-one.json'),'utf8'));rows.push({path:'mcp-probe',kind:'advisor',cost:p.cost});}catch(e){if(e.code!=='ENOENT')throw e;}
 const known=r=>r.cost?.usd??r.cost?.knownPartialUsd??0;
 const unknown=rows.filter(r=>!r.cost?.complete),totalUsd=rows.reduce((n,r)=>n+known(r),0),deepseekUsd=rows.filter(r=>r.kind?.startsWith('dsh-')).reduce((n,r)=>n+known(r),0);
 return {complete:unknown.length===0,totalUsd,deepseekUsd,unknown:unknown.map(r=>r.path),allowed:unknown.length===0&&totalUsd<15&&deepseekUsd<2,rows};
}
export async function checkStudyBudget(){const r=await studyBudget();if(!r.allowed)throw Error('Experiment stop threshold or unknown cost: '+JSON.stringify({totalUsd:r.totalUsd,deepseekUsd:r.deepseekUsd,unknown:r.unknown}));return r;}
