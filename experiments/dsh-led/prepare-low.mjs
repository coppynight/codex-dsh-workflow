import { mkdir,readFile,writeFile,copyFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { cases } from './cases.mjs';
const root=resolve('.local-runs/dsh-led/pilot-low-01');await mkdir(root,{recursive:true});
const freeze={at:new Date().toISOString(),hypothesis:'High-effort DSH has spent 22k+ reasoning tokens on simple changes. Test low effort with the same cases, both alone and with the optional expert tool. Exploratory configuration ablation, not held-out confirmation.',baseline:'Reuse pilot-01 native Astra records without another paid run; same task/spec/source/acceptance. These are not additional independent Astra samples.',effort:'low',attempts:6,existingExperimentSpendApproxUsd:1.5,overallStopBeforeNextCallUsd:15,cases:[]};
for(const [id,data] of Object.entries(cases)){
 const original=resolve('.local-runs/dsh-led/pilot-01',id),base=join(root,id);await mkdir(base,{recursive:true});
 const task=JSON.parse(await readFile(join(original,'astra/spec.json'),'utf8')).task;
 await copyFile(join(original,'acceptance.mjs'),join(base,'acceptance.mjs'));
 freeze.cases.push({id,task,acceptanceSource:join(original,'acceptance.mjs')});
 for(const arm of ['dsh-alone','dsh-advisor']){
  const cwd=join(base,arm,'work');await mkdir(cwd,{recursive:true});
  for(const [name,contents] of Object.entries({...data.files,'visible.test.mjs':data.visible,'package.json':'{"type":"module","private":true}'}))await writeFile(join(cwd,name),contents,{flag:'wx'});
  await writeFile(join(base,arm,'spec.json'),JSON.stringify({cwd,task,outputDir:join(base,arm,'capture'),advisor:arm==='dsh-advisor',reasoningEffort:'low',privateId:'low01-'+id+'-'+arm},null,2),{flag:'wx'});
 }
}
await writeFile(join(root,'freeze.json'),JSON.stringify(freeze,null,2),{flag:'wx'});console.log(JSON.stringify({root,attempts:6}));
