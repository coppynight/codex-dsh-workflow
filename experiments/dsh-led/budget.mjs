import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, basename, dirname } from 'node:path';
import { costOf } from '../../prototype/usage.mjs';
export async function studyBudget() {
 const root=resolve('.local-runs/dsh-led'), rows=[];
 async function walk(path){for(const e of await readdir(path,{withFileTypes:true})){const next=join(path,e.name);if(e.isDirectory())await walk(next);else if(e.name==='record.json'&&basename(dirname(next))==='capture'){
  const r=JSON.parse(await readFile(next,'utf8'));let cost=r.role==='executor'?costOf(r.usageEvents,'astra'):r.cost;
  rows.push({path,cost,kind:r.role,phase:r.phase??'finished'});
  for(const c of r.consultations??[])rows.push({path:path+'/consult/'+(c.consultationId??c.index),cost:c.cost,kind:'advisor'});
 }}}
 await walk(root);
 try{const p=JSON.parse(await readFile(join(root,'mcp-probe-01/ledger/probe-one.json'),'utf8'));rows.push({path:'mcp-probe',kind:'advisor',cost:p.cost});}catch(e){if(e.code!=='ENOENT')throw e;}
 const unknown=rows.filter(r=>!r.cost?.complete),totalUsd=rows.reduce((n,r)=>n+(r.cost?.usd??0),0),deepseekUsd=rows.filter(r=>r.kind?.startsWith('dsh-')).reduce((n,r)=>n+(r.cost?.usd??0),0);
 return {complete:unknown.length===0,totalUsd,deepseekUsd,unknown:unknown.map(r=>r.path),allowed:unknown.length===0&&totalUsd<15&&deepseekUsd<2,rows};
}
export async function checkStudyBudget(){const r=await studyBudget();if(!r.allowed)throw Error('Experiment stop threshold or unknown cost: '+JSON.stringify({totalUsd:r.totalUsd,deepseekUsd:r.deepseekUsd,unknown:r.unknown}));return r;}
