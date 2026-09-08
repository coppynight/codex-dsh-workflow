import {readFile,access} from 'node:fs/promises';import {resolve,join} from 'node:path';import {spawn} from 'node:child_process';
import {checkStudyBudget} from './budget.mjs';
const run=args=>new Promise((done,fail)=>{const c=spawn(process.execPath,args,{cwd:process.cwd(),windowsHide:true,stdio:['ignore','inherit','inherit']});c.on('error',fail);c.on('close',code=>code===0?done():fail(Error('Failed: '+args[0])));});
for(const id of ['incremental-observation','usage-ledger','budget-reservations']){
 await checkStudyBudget();
 const dir=resolve('.local-runs/dsh-led/pilot-compatible-01',id,'dsh-advisor'),file=join(dir,'spec.json');
 try{await access(join(dir,'capture/owner.json'));throw Error('Existing attempt; inspect, never resubmit');}catch(e){if(e.code!=='ENOENT')throw e;}
 const spec=JSON.parse(await readFile(file,'utf8'));if(!spec.workflowConfig)await run(['prototype/isolated-host.mjs',file]);
 await run(['experiments/dsh-led/run-arm.mjs',id,'dsh-advisor','pilot-compatible-01']);
}
