import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {cases} from './cases.mjs';
const [caseId,mode,output]=process.argv.slice(2);
if(!cases[caseId] || !['implement','review'].includes(mode) || !output || !isAbsolute(output))throw new Error('Usage: node run-astra.mjs CASE implement|review ABS_OUTPUT');
const root=resolve(output),work=join(root,'work'),spec=cases[caseId];await mkdir(work,{recursive:true});
for(const file of [join(root,`${mode}-record.json`),...(mode==='implement'?[join(work,'solution.mjs')]:[])]){
  try{await access(file);throw new Error('Existing run/output would be overwritten; use a fresh run directory.');}catch(e){if(e.code!=='ENOENT')throw e;}
}
if(mode==='implement'){await writeFile(join(work,'solution.mjs'),'');await writeFile(join(work,'visible-test.mjs'),spec.visible);}
const source=mode==='review'?await readFile(join(work,'solution.mjs'),'utf8'):'';
const prompt=`This is a bounded code-generation experiment. Do not call any tools, execute commands, access files, load skills, or delegate. Return JSON with solution (the complete solution.mjs source) and notes (brief review observations). A separate deterministic harness will write and test your returned source; you must not claim to have executed tests. ${mode==='implement'?'Implement the requested solution.':'Independently review the supplied DSH implementation against requirements and correct confirmed defects; return the complete resulting source.'}\n\nREQUIREMENTS:\n${spec.specification}\n\nVISIBLE TEST:\n${spec.visible}\n\nEXISTING SOLUTION:\n${source}`;
await writeFile(join(root,`${mode}-prompt.txt`),prompt);
const schema=join(root,'response-schema.json');await writeFile(schema,JSON.stringify({type:'object',properties:{solution:{type:'string'},notes:{type:'string'}},required:['solution','notes'],additionalProperties:false}));
const args=['exec','--ignore-user-config','--ephemeral','--json','--skip-git-repo-check','--output-schema',schema,'-m','gpt-6-astra','-c','model_reasoning_effort="medium"','-c','approval_policy="never"','-c','web_search="disabled"','-s','read-only','-C',work,'-'];
const started=Date.now();const cli=process.env.CODEX_EXECUTABLE||(process.platform==='win32'?'codex.exe':'codex');
const child=spawn(cli,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',timedOut=false;
child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
let finish;const completion=new Promise(r=>{finish=r;child.once('error',e=>{stderr+='CLI launch failed: '+e.code; r(null);});child.once('close',r);});
child.stdin.on('error',()=>{});
const timer=setTimeout(()=>{timedOut=true;child.kill();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();finish(null);},600000);child.stdin.end(prompt);
const code=await completion;clearTimeout(timer);
await writeFile(join(root,`${mode}-raw.jsonl`),stdout);await writeFile(join(root,`${mode}-stderr.log`),stderr);
const events=stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const usageEvents=events.filter(e=>e.type==='turn.completed'&&e.usage).map(e=>({type:e.type,usage:e.usage}));
const record={caseId,mode,requestedModel:'gpt-6-astra',reasoningEffort:'medium',startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started,exitCode:code,timedOut,promptSha256:createHash('sha256').update(prompt).digest('hex'),usageEvents,failures:events.filter(e=>['error','turn.failed'].includes(e.type)),answer:events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').map(e=>e.item.text).join('\n')};
await writeFile(join(root,`${mode}-record.json`),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record));
if(code===0&&!timedOut){const answer=JSON.parse(events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item.text);if(typeof answer.solution!=='string')throw new Error('Missing solution');await writeFile(join(work,'solution.mjs'),answer.solution);}
