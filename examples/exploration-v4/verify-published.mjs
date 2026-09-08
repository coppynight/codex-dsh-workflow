import {readFile,copyFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {sourceFiles} from '../budget-v3/case.mjs';
import {astraCost,dshCost} from '../budget-v3/cost.mjs';
const read=async p=>JSON.parse(await readFile(new URL(p,import.meta.url),'utf8'));
const summary=await read('./results/summary.json'),freeze=await read('./results/freeze.json'),plan=await read('../budget-v3/results/plan-record.json');
for(const f of freeze.files)assert.equal(createHash('sha256').update(await readFile(new URL(f.file,import.meta.url))).digest('hex'),f.sha256);
for(const v of summary.variants){
 const base='./results/'+v.id+'/',d=await read(base+'dsh-record.json'),a=await read(base+'review-record.json');assert.equal(v.executionUSD,dshCost(d.usageEvents,true));assert.equal(v.astraPlanAndReviewUSD,astraCost(plan.usageEvents)+astraCost(a.usageEvents));
 const expected=await read(base+'diagnostic.json'),root=await mkdtemp(join(tmpdir(),'workflow-v4-replay-'));
 try{for(const file of sourceFiles)await copyFile(new URL(base+file,import.meta.url),join(root,file));await copyFile(new URL('../budget-v3/fixture/acceptance.mjs',import.meta.url),join(root,'acceptance.mjs'));
 const run=args=>spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
 const test=run(['acceptance.mjs']);assert.equal(test.status,0);assert.deepEqual(JSON.parse(test.stdout),v.frozenAcceptance);
 const diagnostic=run([fileURLToPath(new URL('./diagnostic.mjs',import.meta.url)),root,join(root,'diagnostic.json')]);assert.equal(diagnostic.status,0,diagnostic.stderr);assert.deepEqual(JSON.parse(diagnostic.stdout),expected);
 console.log(JSON.stringify({id:v.id,frozenChecks:v.frozenAcceptance.passed,diagnosticsMatch:true,costLedgerMatches:true}));
 }finally{await rm(root,{recursive:true,force:true});}
}
