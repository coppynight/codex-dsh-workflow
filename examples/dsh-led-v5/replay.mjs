// Offline only: no model, credentials, DSH installation or network required.
import {readFile} from 'node:fs/promises';import {dirname,resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const root=dirname(fileURLToPath(import.meta.url)),summary=JSON.parse(await readFile(join(root,'summary.json'),'utf8'));
// These pilots use top-level node:test cases. Compare the actual cases, not just
// a nonzero exit: a broken test runner must never reproduce a semantic failure.
function casesFromSpec(text){return [...text.split(/\r?\n/).slice(0,text.split(/\r?\n/).findIndex(l=>l.startsWith('ℹ tests '))).join('\n').matchAll(/^([✔✖]) (.+) \([\d.]+ms\)$/gm)].map(m=>({name:m[2],passed:m[1]==='✔'}));}
function casesFromTap(text){return [...text.matchAll(/^(ok|not ok) \d+ - (.+)$/gm)].map(m=>({name:m[2],passed:m[1]==='ok'}));}
let mismatches=0;
for(const row of summary.runs){
 const dir=join(root,row.id),cwd=join(dir,'work');
 for(const [file,expected]of Object.entries(row.sourceHashes)){const actual=createHash('sha256').update(await readFile(join(cwd,file))).digest('hex');if(actual!==expected)throw Error('Source hash mismatch: '+row.id+'/'+file);}
 const acceptance=resolve(dir,'../acceptance.mjs');
 if(createHash('sha256').update(await readFile(acceptance)).digest('hex')!==row.acceptanceSha256)throw Error('Frozen acceptance hash mismatch: '+row.id);
 const result=spawnSync(process.execPath,['--test','--test-reporter=tap',acceptance],{cwd,env:{...process.env,TARGET_CWD:cwd},encoding:'utf8',timeout:30000,windowsHide:true});
 const expected=casesFromSpec(row.acceptance.stdout??''),actual=casesFromTap(result.stdout??'');
 const complete=!result.error&&[0,1].includes(result.status)&&expected.length>0&&actual.length===expected.length&&['cancelled','skipped','todo'].every(k=>new RegExp('^# '+k+' 0$','m').test(result.stdout));
 const passed=result.status===0,matches=complete&&passed===row.passed&&JSON.stringify(actual)===JSON.stringify(expected);
 console.log(JSON.stringify({id:row.id,expectedPass:row.passed,actualPass:passed,complete,matches,failedTests:actual.filter(c=>!c.passed).map(c=>c.name)}));
 if(!matches){mismatches++;console.log(result.stdout,result.stderr);}
}
console.log(JSON.stringify({attempts:summary.runs.length,mismatches,note:'Known failed artifacts are expected to fail; replay validates recorded outcomes, not all implementations.'}));
process.exitCode=mismatches?1:0;
