import {mkdtemp,mkdir,copyFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cases} from './cases.mjs';
const here=dirname(fileURLToPath(import.meta.url));let failures=0;
for(const id of Object.keys(cases))for(const arm of ['astra','workflow','dsh']){
 const temp=await mkdtemp(join(tmpdir(),'workflow-published-'));
 try{await mkdir(join(temp,'work'));await copyFile(join(here,'../results',id,`${arm}-solution.mjs`),join(temp,'work/solution.mjs'));
 const run=spawnSync(process.execPath,[join(here,'accept.mjs'),id,temp],{encoding:'utf8',timeout:25000});if(run.status!==0)throw new Error('Harness failed: '+run.stderr);
 const actual=JSON.parse(run.stdout),expected=JSON.parse(await readFile(join(here,'../results',id,`${arm}-acceptance.json`),'utf8'));
 const matches=actual.passed===expected.passed&&actual.details.passed===expected.details.passed&&actual.details.total===expected.details.total&&actual.solutionSha256===expected.solutionSha256;
 console.log(JSON.stringify({id,arm,passed:actual.details.passed,total:actual.details.total,matchesPublished:matches}));if(!matches)failures++;
 }finally{await rm(temp,{recursive:true,force:true});}
}
if(failures)process.exitCode=1;
