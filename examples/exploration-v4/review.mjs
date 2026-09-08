import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {specification,sourceFiles} from '../budget-v3/case.mjs';
const [root,id,phase='prepare']=process.argv.slice(2);if(!isAbsolute(root||''))throw Error('Absolute root required');const dir=join(root,id),work=join(dir,'work');
const run=name=>{const r=spawnSync(process.execPath,[name],{cwd:work,encoding:'utf8',timeout:20000,windowsHide:true});return {command:'node '+name,exitCode:r.status,stdout:r.stdout,stderr:r.stderr};};
if(phase==='score'){
 await copyFile(new URL('../budget-v3/fixture/acceptance.mjs',import.meta.url),join(work,'acceptance.mjs'));
 const result={...run('acceptance.mjs'),files:await Promise.all(sourceFiles.map(async file=>({file,sha256:createHash('sha256').update(await readFile(join(work,file))).digest('hex')})))};
 await writeFile(join(dir,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}else{
 const visible=run('visible-test.mjs');await writeFile(join(dir,'review-visible.json'),JSON.stringify(visible,null,2));
 const plan=JSON.parse(await readFile(new URL('../budget-v3/results/plan-record.json',import.meta.url))).answer.plan;
 const files=Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,await readFile(join(work,f),'utf8')])));
 const prompt='You are the independent acceptance reviewer. Do not call tools, execute commands, read files, load skills or delegate. The implementation executor identity is intentionally omitted. Return only JSON with verdict accept|repair, findings (array of concrete blocking defects tied to a requirement; empty if none), and notes. Do not emit source code, do not rewrite implementation, do not invent additional requirements. The external harness ran the visible test; distinguish that evidence from your source review.\n\nREQUIREMENTS\n'+specification+'\n\nSHARED ASTRA PLAN\n'+plan+'\n\nFILES\n'+JSON.stringify(files)+'\n\nVISIBLE TEST RESULT\n'+JSON.stringify(visible);
 const schema={type:'object',properties:{verdict:{type:'string',enum:['accept','repair']},findings:{type:'array',items:{type:'string'}},notes:{type:'string'}},required:['verdict','findings','notes'],additionalProperties:false};
 await writeFile(join(dir,'review-request.json'),JSON.stringify({stage:'review',work,output:dir,prompt,schema}));console.log(JSON.stringify({id,visible}));
}
