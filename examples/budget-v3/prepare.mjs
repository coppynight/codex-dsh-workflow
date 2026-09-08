import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {specification,sourceFiles} from './case.mjs';
const [root,phase]=process.argv.slice(2);if(!isAbsolute(root||''))throw Error('Absolute output directory required');
const visible=await readFile(new URL('./fixture/visible-test.mjs',import.meta.url),'utf8');
const noTools='Do not call tools, execute commands, read files, load skills or delegate. A deterministic external harness applies sources and runs tests. Do not claim you executed tests. Return only the requested JSON.';
const str={type:'string'},obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const save=async(name,data)=>writeFile(join(root,name),JSON.stringify(data,null,2)+'\n');
await mkdir(root,{recursive:true});
if(phase==='plan'){
 await save('freeze.json',{at:new Date().toISOString(),files:await Promise.all(['case.mjs','fixture/visible-test.mjs','fixture/acceptance.mjs','PROTOCOL.md'].map(async p=>({path:p,sha256:createHash('sha256').update(await readFile(new URL(p,import.meta.url))).digest('hex')})))});
 await save('plan-request.json',{stage:'plan',work:join(root,'planner'),output:join(root,'plan'),schema:obj({plan:str}),prompt:noTools+'\nDesign a concise implementation contract for these requirements: module boundaries, tricky cases, acceptance priorities. Do not produce implementation code.\n\n'+specification+'\n\nVISIBLE TEST\n'+visible});
}else if(phase==='implement'){
 const plan=JSON.parse(await readFile(join(root,'plan','plan-record.json'))).answer.plan;
 const common='REQUIREMENTS\n'+specification+'\n\nSHARED ASTRA PLAN\n'+plan+'\n\nVISIBLE TEST\n'+visible;
 for(const arm of ['a','b']){await mkdir(join(root,arm,'work'),{recursive:true});await copyFile(new URL('./fixture/visible-test.mjs',import.meta.url),join(root,arm,'work','visible-test.mjs'));}
 await save('a-request.json',{stage:'implement',work:join(root,'a','work'),output:join(root,'a'),schema:obj({files:obj(Object.fromEntries(sourceFiles.map(n=>[n,str]))),notes:str}),prompt:noTools+'\nImplement all three complete source files.\n\n'+common});
 await save('b-request.json',{taskId:'budget-v3-job-report-20260908',cwd:join(root,'b','work'),prompt:'You own implementation in this isolated non-git fixture directory. Allowed writes: parse.mjs, aggregate.mjs, cli.mjs only. Do not modify visible-test.mjs or read outside cwd. No external delegation. Implement and self-test with node visible-test.mjs. Stop and report if credentials, expanded scope or approvals are needed; do not retry permission failures. Return changed files, actual test result and unresolved issues.\n\n'+common});
}else throw Error('Unknown phase');
