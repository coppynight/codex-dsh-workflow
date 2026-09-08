// Post-hoc diagnostics prompted by review findings. Not part of frozen scoring.
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const [work,output]=process.argv.slice(2);if(![work,output].every(isAbsolute))throw Error('Absolute source and result paths required');
const {parseJobs}=await import(pathToFileURL(join(work,'parse.mjs')));
const root=await mkdtemp(join(tmpdir(),'workflow-diagnostic-'));
const run=(args)=>spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,timeout:10000});
try{
 const input=join(root,'input.ndjson'),dest=join(root,'out.json');await writeFile(input,JSON.stringify({id:'a',durationMs:1,status:'succeeded'}));
 const marker='NOT_A_REAL_CREDENTIAL_123';const privacy=run([join(work,'cli.mjs'),join(root,marker),dest]);
 if(privacy.status!==1||privacy.error)throw Error('Privacy probe did not complete expected missing-input branch; result unverified');
 const hook=join(root,'collision-hook.mjs');
 await writeFile(hook,"import fsp from 'node:fs/promises';import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';const original=fsp.open,dir=path.dirname(process.argv.at(-1));let injected=false;fsp.open=async function(file,flags,...rest){if(!injected&&typeof flags==='string'&&flags.includes('wx')){const absolute=path.resolve(file);if(path.dirname(absolute)!==dir)throw Error('Unexpected fixture path');injected=true;fs.writeFileSync(absolute,'unrelated-fixture');fs.writeFileSync(path.join(dir,'collision-path'),absolute);const e=new Error('Injected EEXIST');e.code='EEXIST';throw e;}return original.call(this,file,flags,...rest);};fs.writeFileSync(path.join(dir,'hook-ready'),'ready');syncBuiltinESMExports();");
 const collision=run(['--import',pathToFileURL(hook).href,join(work,'cli.mjs'),input,dest]);
 if(await readFile(join(root,'hook-ready'),'utf8').catch(()=>null)!=='ready')throw Error('Diagnostic hook did not run; no collision conclusion is valid');
 const collisionPath=await readFile(join(root,'collision-path'),'utf8').catch(()=>null);if(!collisionPath)throw Error('No exclusive open was intercepted; no collision conclusion is valid');
 const markerPreserved=await readFile(collisionPath,'utf8').catch(()=>null)==='unrelated-fixture';
 const invalidIds=['a\n','a\r','a\u2028','a\u2029'];const invalidIdResults=invalidIds.map(id=>({id,rejected:parseJobs(JSON.stringify({id,durationMs:1,status:'succeeded'})).jobs.length===0}));
 const result={kind:'Post-hoc diagnostic; not preregistered acceptance',invalidIdResults,reviewRegexFindingConfirmed:invalidIdResults.some(x=>!x.rejected),privacyProbe:{exitCode:privacy.status,timedOut:false,launchError:null},errorMessageLeaksPathMarker:privacy.stderr.includes(marker),collision:{exitCode:collision.status,timedOut:collision.error?.code==='ETIMEDOUT',injectedCollisions:1,unrelatedFilePreserved:markerPreserved,deletedUnownedTemp:!markerPreserved},notes:'One EEXIST is injected at the actual exclusive-open path in an isolated fixture; named imports are synchronized before source loading. Original sources unchanged; no filename-shape assumptions.'};
 await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await rm(root,{recursive:true,force:true});}
