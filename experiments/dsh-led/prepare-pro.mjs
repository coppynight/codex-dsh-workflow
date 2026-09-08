import {mkdir,readFile,writeFile,copyFile}from 'node:fs/promises';import {resolve,join}from 'node:path';import {nextCase}from './next-case.mjs';
const root=resolve('.local-runs/dsh-led/pilot-pro-01'),base=join(root,'durable-jobs'),cwd=join(base,'dsh-alone/work');await mkdir(cwd,{recursive:true});
const source=resolve('.local-runs/dsh-led/pilot-next-01/durable-jobs');
const original=JSON.parse(await readFile(join(source,'dsh-alone/spec.json'),'utf8'));
for(const [name,text]of Object.entries({...nextCase.files,'visible.test.mjs':nextCase.visible,'package.json':'{"type":"module","private":true}'}))await writeFile(join(cwd,name),text,{flag:'wx'});
await copyFile(join(source,'acceptance.mjs'),join(base,'acceptance.mjs'));
await writeFile(join(base,'dsh-alone/spec.json'),JSON.stringify({cwd,task:original.task,outputDir:join(base,'dsh-alone/capture'),advisor:false,model:'deepseek-v4-pro',reasoningEffort:'high',automaticRepair:true,privateId:'pro01-durable-jobs'},null,2),{flag:'wx'});
await writeFile(join(root,'freeze.json'),JSON.stringify({at:new Date().toISOString(),hypothesis:'Check whether a stronger inexpensive primary model is a better alternative to repeated Flash repair. One additional model profile on the same prospective fourth task; not a new task or evidence of expert routing.',model:'deepseek-v4-pro',reasoningEffort:'high',task:original.task,acceptanceSource:'pilot-next-01/durable-jobs/acceptance.mjs',maxRepairs:1,advisor:false,pricesUsdPerM:{input:1.32,cache:0.044,output:3.96},source:'https://api-docs.deepseek.com/quick_start/pricing/',overallStopBeforeNextCallUsd:15,deepseekStopBeforeNextCallUsd:2},null,2),{flag:'wx'});
console.log(JSON.stringify({root,attempts:1}));
