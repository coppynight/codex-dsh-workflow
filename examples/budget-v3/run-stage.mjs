import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const [requestPath]=process.argv.slice(2);
if(!isAbsolute(requestPath||''))throw Error('Pass an absolute request JSON path');
const request=JSON.parse(await readFile(requestPath,'utf8'));
const {stage,work,output,prompt,schema}=request;
if(!['plan','implement','review','repair','rereview'].includes(stage)||![work,output].every(isAbsolute))throw Error('Invalid request');
await mkdir(output,{recursive:true});await mkdir(work,{recursive:true});
const recordPath=join(output,stage+'-record.json');
try{await access(recordPath);throw Error('Run already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
const schemaPath=join(output,stage+'-schema.json');await writeFile(schemaPath,JSON.stringify(schema));
await writeFile(join(output,stage+'-prompt.txt'),prompt);
const args=['exec','--ignore-user-config','--ephemeral','--json','--skip-git-repo-check','--output-schema',schemaPath,'-m','gpt-6-astra','-c','model_reasoning_effort="medium"','-c','approval_policy="never"','-c','web_search="disabled"','-s','read-only','-C',work,'-'];
const started=Date.now();const child=spawn(process.env.CODEX_EXECUTABLE||(process.platform==='win32'?'codex.exe':'codex'),args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
let stdout='',stderr='',timedOut=false,finish;
child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.stdin.on('error',()=>{});
const completion=new Promise(r=>{finish=r;child.once('error',e=>{stderr+='Launch failure '+e.code;r(null);});child.once('close',r);});
const timer=setTimeout(()=>{timedOut=true;child.kill();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();finish(null);},600000);
child.stdin.end(prompt);const exitCode=await completion;clearTimeout(timer);
await writeFile(join(output,stage+'-raw.jsonl'),stdout);await writeFile(join(output,stage+'-stderr.log'),stderr);
const events=stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const answerText=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item.text;
let answer=null;try{answer=JSON.parse(answerText);}catch{}
const record={stage,model:'gpt-6-astra',effort:'medium',startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started,exitCode,timedOut,promptSha256:createHash('sha256').update(prompt).digest('hex'),usageEvents:events.filter(e=>e.type==='turn.completed'&&e.usage).map(e=>({type:e.type,usage:e.usage})),toolItems:events.filter(e=>e.type==='item.completed'&&e.item?.type!=='agent_message'&&e.item?.type!=='reasoning').map(e=>e.item.type),answer};
await writeFile(recordPath,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({...record,answer:answer?Object.keys(answer):null}));
if(exitCode!==0||timedOut||!answer)process.exitCode=1;
