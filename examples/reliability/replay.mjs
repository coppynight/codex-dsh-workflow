// Reconstruct three specific regressions; local fixtures only, no real services or credentials.
import {mkdtemp,cp,symlink,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const variants=[
 {id:'custom-config',file:'bridge/invoke.mjs',test:'tests/portable-helpers.test.mjs',pattern:'CLI transport forwards',change:s=>s.replace('env: process.env.WORKFLOW_CONFIG ? { WORKFLOW_CONFIG: configPath() } : {},','env: {},')},
 {id:'corrupt-cooldown',file:'scripts/dsh-recover.mjs',test:'tests/portable-helpers.test.mjs',pattern:'typed but corrupt cooldown',change:s=>s.replace('if (invalidAccounting) throw stateError','if (false && invalidAccounting) throw stateError')},
 {id:'auth-refresh',file:'bridge/client.mjs',test:'tests/auth-refresh.test.mjs',pattern:'follow: stale handshake',change:s=>s.replace('!retried && (handshakeStatus === 401 || handshakeStatus === 403)','false && !retried && (handshakeStatus === 401 || handshakeStatus === 403)')}
];
const result={kind:'reconstructed-regression-replay',date:new Date().toISOString(),node:process.version,platform:process.platform,cases:[]};
for(const v of variants){
 const temp=await mkdtemp(join(tmpdir(),'workflow-regression-'));
 try{
  for(const entry of ['bridge','scripts','tests','package.json','SKILL.md'])await cp(join(repo,entry),join(temp,entry),{recursive:true});
  await symlink(join(repo,'node_modules'),join(temp,'node_modules'),process.platform==='win32'?'junction':'dir');
  const file=join(temp,v.file),original=await readFile(file,'utf8'),mutant=v.change(original);if(mutant===original)throw new Error('Mutation no longer matches: '+v.id);
  const outcomes={};
  for(const [name,source] of [['regression',mutant],['fixed',original]]){
   await writeFile(file,source);const start=Date.now();const run=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern',v.pattern,v.test],{cwd:temp,encoding:'utf8',timeout:30000});
   outcomes[name]={exitCode:run.status,elapsedMs:Date.now()-start,passed:run.status===0,matchedPass:(run.stdout.match(/^ok \d+ /gm)||[]).length,matchedFail:(run.stdout.match(/^not ok \d+ /gm)||[]).length,timedOut:run.error?.code==='ETIMEDOUT'};
  }
  result.cases.push({id:v.id,source:v.file,test:v.test,pattern:v.pattern,...outcomes,verified:!outcomes.regression.passed&&outcomes.regression.matchedFail>0&&outcomes.fixed.passed});
 }finally{await rm(temp,{recursive:true,force:true});}
}
await mkdir(join(repo,'examples/results'),{recursive:true});await writeFile(join(repo,'examples/results/reliability.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(result.cases.some(c=>!c.verified))process.exitCode=1;
