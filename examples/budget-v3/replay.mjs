import {mkdtemp,copyFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {sourceFiles} from './case.mjs';
const root=await mkdtemp(join(tmpdir(),'workflow-v3-replay-'));
try{
 for(const arm of ['a','b']){
  for(const file of sourceFiles)await copyFile(new URL('./results/'+arm+'/'+file,import.meta.url),join(root,file));
  await copyFile(new URL('./fixture/acceptance.mjs',import.meta.url),join(root,'acceptance.mjs'));
  const r=spawnSync(process.execPath,['acceptance.mjs'],{cwd:root,encoding:'utf8',timeout:60000,windowsHide:true});
  const expected=JSON.parse(await readFile(new URL('./results/'+arm+'/acceptance.json',import.meta.url)));
  const actual=JSON.parse(r.stdout);console.log(JSON.stringify({arm,exitCode:r.status,...actual}));
  if(r.status!==expected.exitCode||JSON.stringify(actual)!==JSON.stringify(JSON.parse(expected.stdout)))throw Error('Published result mismatch');
 }
}finally{await rm(root,{recursive:true,force:true});}
