import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {configPath,loadConfig} from '../../scripts/config.mjs';
const [root,priorRoot]=process.argv.slice(2);if(![root,priorRoot].every(isAbsolute))throw Error('Two absolute run directories required');
await mkdir(root,{recursive:true});
const original=JSON.parse(await readFile(join(priorRoot,'b-request.json'),'utf8'));
const config=JSON.parse((await readFile(configPath(),'utf8')).replace(/^\uFEFF/,''));
const common=original.prompt.slice(original.prompt.indexOf('REQUIREMENTS\n'));
const bound='You implement in this isolated non-git fixture. Write only parse.mjs, aggregate.mjs and cli.mjs. All product requirements below remain mandatory. The environment owner performs independent integration verification after your return. Your self-test scope is exactly node visible-test.mjs, once; fix a reported product defect and rerun once only if it fails. Do not create extra tests or temp files, do not spawn child-process capture experiments, do not probe shell workarounds, do not change services. If that command is blocked, immediately report it and return existing source for owner verification. Do not read outside cwd, use network/packages, delegate or create background jobs. Return changed paths, actual visible-test result and unresolved product defects.\n\n';
const variants=[{id:'original-low',effort:'low',prompt:original.prompt},{id:'bounded-high',effort:'high',prompt:bound+common},{id:'bounded-low',effort:'low',prompt:bound+common}];
for(const v of variants){const dir=join(root,v.id),work=join(dir,'work');await mkdir(work,{recursive:true});await copyFile(new URL('../budget-v3/fixture/visible-test.mjs',import.meta.url),join(work,'visible-test.mjs'));
 const cfg=structuredClone(config);cfg.dsh.model={...loadConfig().dsh.model,reasoningEffort:v.effort};await writeFile(join(dir,'config.json'),JSON.stringify(cfg,null,2));
 await writeFile(join(dir,'request.json'),JSON.stringify({taskId:'explore-v4-'+v.id+'-20260908',cwd:work,prompt:v.prompt},null,2));
}
const freeze={at:new Date().toISOString(),variants:variants.map(({id,effort,prompt})=>({id,effort,promptSha256:createHash('sha256').update(prompt).digest('hex')})),files:await Promise.all(['PROTOCOL.md','../budget-v3/case.mjs','../budget-v3/fixture/visible-test.mjs','../budget-v3/fixture/acceptance.mjs'].map(async file=>({file,sha256:createHash('sha256').update(await readFile(new URL(file,import.meta.url))).digest('hex')})))};
await writeFile(join(root,'freeze.json'),JSON.stringify(freeze,null,2));console.log(JSON.stringify(freeze));
