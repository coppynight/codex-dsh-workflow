import {writeFile,copyFile,rm,mkdtemp,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {cases} from './cases.mjs';
const [id,root]=process.argv.slice(2);if(!cases[id]||!isAbsolute(root||''))throw new Error('Usage: node accept.mjs CASE ABS_RUN_DIRECTORY');
const temp=await mkdtemp(join(tmpdir(),'workflow-accept-'));
try{await copyFile(join(root,'work/solution.mjs'),join(temp,'solution.mjs'));await writeFile(join(temp,'acceptance.mjs'),cases[id].acceptance);
const result=spawnSync(process.execPath,[join(temp,'acceptance.mjs')],{encoding:'utf8',timeout:20000});let details;try{details=JSON.parse(result.stdout.trim());}catch{details={passed:0,total:null,error:'Acceptance program failed',stderr:result.stderr?.slice(-1500)};}
const data={caseId:id,passed:result.status===0,exitCode:result.status,details,solutionSha256:createHash('sha256').update(await readFile(join(temp,'solution.mjs'))).digest('hex')};await writeFile(join(root,'acceptance.json'),JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify(data));
}finally{await rm(temp,{recursive:true,force:true});}
