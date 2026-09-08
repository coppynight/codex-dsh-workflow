import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {specification,sourceFiles} from './case.mjs';
const [root,arm,phase='review']=process.argv.slice(2);if(!isAbsolute(root||'')||!['a','b'].includes(arm))throw Error('Absolute root and a|b required');
const dir=join(root,arm),work=join(dir,'work');
if(arm==='a'&&phase==='review'){
 const record=JSON.parse(await readFile(join(dir,'implement-record.json')));
 if(record.exitCode!==0||record.toolItems.length||!record.answer?.files)throw Error('Implementation invalid');
 for(const file of sourceFiles)await writeFile(join(work,file),record.answer.files[file]);
}
if(phase==='score'){
 await copyFile(new URL('./fixture/acceptance.mjs',import.meta.url),join(work,'acceptance.mjs'));
 const r=spawnSync(process.execPath,['acceptance.mjs'],{cwd:work,encoding:'utf8',timeout:60000,windowsHide:true});
 const result={exitCode:r.status,stdout:r.stdout,stderr:r.stderr,files:await Promise.all(sourceFiles.map(async file=>({file,sha256:createHash('sha256').update(await readFile(join(work,file))).digest('hex')})))};
 await writeFile(join(dir,'acceptance.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}else{
 const visible=spawnSync(process.execPath,['visible-test.mjs'],{cwd:work,encoding:'utf8',timeout:10000,windowsHide:true});
 const test={command:'node visible-test.mjs',exitCode:visible.status,stdout:visible.stdout,stderr:visible.stderr};
 await writeFile(join(dir,phase+'-visible.json'),JSON.stringify(test,null,2)+'\n');
 const plan=JSON.parse(await readFile(join(root,'plan','plan-record.json'))).answer.plan;
 const files=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,await readFile(join(work,file),'utf8')])));
 const prompt='You are the independent acceptance reviewer. Do not call tools, execute commands, read files, load skills or delegate. The implementation executor identity is intentionally omitted. Return only JSON with verdict accept|repair, findings (array of concrete blocking defects tied to a requirement; empty if none), and notes. Do not emit source code, do not rewrite implementation, do not invent additional requirements. The external harness ran the visible test; distinguish that evidence from your source review.\n\nREQUIREMENTS\n'+specification+'\n\nSHARED ASTRA PLAN\n'+plan+'\n\nFILES\n'+JSON.stringify(files)+'\n\nVISIBLE TEST RESULT\n'+JSON.stringify(test);
 const schema={type:'object',properties:{verdict:{type:'string',enum:['accept','repair']},findings:{type:'array',items:{type:'string'}},notes:{type:'string'}},required:['verdict','findings','notes'],additionalProperties:false};
 await writeFile(join(root,arm+'-'+phase+'-request.json'),JSON.stringify({stage:phase,work,output:dir,prompt,schema},null,2)+'\n');console.log(JSON.stringify({arm,phase,test}));
}
