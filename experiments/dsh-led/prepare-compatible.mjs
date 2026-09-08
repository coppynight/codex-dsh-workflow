import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {cases} from './cases.mjs';
const root=resolve('.local-runs/dsh-led/pilot-compatible-01');await mkdir(root,{recursive:true});
const freeze={at:new Date().toISOString(),hypothesis:'Low-effort cheap driver plus optional expert, with Node test execution in-process, may remove Windows child-process permission interruptions. Same known cases; exploratory harness tuning, not held-out evidence.',change:'Only replace required visible-test invocation with node --test --test-isolation=none visible.test.mjs. DSH sandbox and approval policy unchanged. Independent acceptance still uses default process isolation outside the model workspace.',source:'https://nodejs.org/download/release/v24.15.0/docs/api/cli.html#--test-isolationmode',baseline:'Original pilot-01 Astra baseline reused, not rerun. No general capability or advisor-benefit claim.',effort:'low',attempts:3,arm:'dsh-advisor',overallStopBeforeNextCallUsd:15,deepseekStopBeforeNextCallUsd:2,cases:[]};
for(const [id,data]of Object.entries(cases)){
 const original=resolve('.local-runs/dsh-led/pilot-01',id),base=join(root,id),arm=join(base,'dsh-advisor'),cwd=join(arm,'work');await mkdir(cwd,{recursive:true});
 const task=JSON.parse(await readFile(join(original,'astra/spec.json'),'utf8')).task.replace('Run node --test visible.test.mjs and your additional checks.','Run node --test --test-isolation=none visible.test.mjs and your additional checks in the same process. This test-runner option avoids spawning a child process; keep the existing sandbox and approval policy unchanged.');
 await copyFile(join(original,'acceptance.mjs'),join(base,'acceptance.mjs'));
 const acceptance=await readFile(join(base,'acceptance.mjs'));
 freeze.cases.push({id,task,taskSha256:createHash('sha256').update(task).digest('hex'),acceptanceSha256:createHash('sha256').update(acceptance).digest('hex')});
 for(const [name,contents]of Object.entries({...data.files,'visible.test.mjs':data.visible,'package.json':'{"type":"module","private":true}'}))await writeFile(join(cwd,name),contents,{flag:'wx'});
 await writeFile(join(arm,'spec.json'),JSON.stringify({cwd,task,outputDir:join(arm,'capture'),advisor:true,reasoningEffort:'low',privateId:'compatible01-'+id},null,2),{flag:'wx'});
}
await writeFile(join(root,'freeze.json'),JSON.stringify(freeze,null,2),{flag:'wx'});console.log(JSON.stringify({root,attempts:3}));
