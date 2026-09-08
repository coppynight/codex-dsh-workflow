// Allowlisted public export: no full model JSONL, chain of thought, session cookies or Host logs.
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {cases} from './cases.mjs';
const root=process.argv[2];if(!isAbsolute(root||''))throw new Error('Usage: node export-results.mjs ABS_PRIVATE_RUN_ROOT');
const out=join(dirname(fileURLToPath(import.meta.url)),'../results');await mkdir(out,{recursive:true});
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const paired={revision:2,date:'2026-09-08',environment:{os:'Windows',node:'24.18.0',codexCLI:'0.153.4',dsh:'0.1.2-rc.1'},scope:'Fixed-requirement code-generation/review sub-sessions. Excludes parent planning/orchestration, page work and auxiliary DSH title generation. Not complete end-to-end performance.',cases:[]};
for(const [id,spec]of Object.entries(cases)){
 const dir=join(out,id);await mkdir(dir,{recursive:true});const arms={};
 for(const [arm,mode] of [['astra','implement'],['workflow','review']]){
  const source=join(root,`${id}-${arm}-r2`),record=await json(join(source,`${mode}-record.json`));
  const {answer,...safe}=record;const output=JSON.parse(answer);
  const recordOut={...safe,notes:output.notes,rawJsonlSha256:await hash(join(source,`${mode}-raw.jsonl`))};
  await writeFile(join(dir,`${arm}-usage.json`),JSON.stringify(recordOut,null,2)+'\n');
  await copyFile(join(source,'work/solution.mjs'),join(dir,`${arm}-solution.mjs`));await copyFile(join(source,`${mode}-prompt.txt`),join(dir,`${arm}-prompt.txt`));
  const acceptance=await json(join(source,'acceptance.json'));await writeFile(join(dir,`${arm}-acceptance.json`),JSON.stringify(acceptance,null,2)+'\n');
  const usage=record.usageEvents.reduce((a,e)=>{for(const[k,v]of Object.entries(e.usage))if(typeof v==='number')a[k]=(a[k]||0)+v;return a;},{});
  arms[arm]={astraTokens:usage.input_tokens+usage.output_tokens,usage,elapsedMs:record.elapsedMs,acceptance,solutionFile:`${id}/${arm}-solution.mjs`,usageFile:`${id}/${arm}-usage.json`};
  if(arm==='workflow'){
   const dsh=await json(join(source,'dsh-record.json'));await writeFile(join(dir,'dsh-usage.json'),JSON.stringify(dsh,null,2)+'\n');await copyFile(join(source,'dsh-solution.mjs'),join(dir,'dsh-solution.mjs'));const before=await json(join(source,'dsh-acceptance.json'));await writeFile(join(dir,'dsh-acceptance.json'),JSON.stringify(before,null,2)+'\n');
   arms[arm].dsh={usageTotals:dsh.usageTotals,elapsedMs:dsh.elapsedMs,acceptance:before};arms[arm].stageElapsedMs=dsh.elapsedMs+record.elapsedMs;
  }
 }
 paired.cases.push({id,title:spec.title,...arms,astraReductionPct:Number(((1-arms.workflow.astraTokens/arms.astra.astraTokens)*100).toFixed(2))});
}
await copyFile(join(root,'log-redaction-astra-r2/acceptance-initial.json'),join(out,'log-redaction/acceptance-before-spec-correction.json'));
const pilot=await json(join(root,'log-redaction-astra/implement-record.json'));await writeFile(join(out,'pilot-environment-failure.json'),JSON.stringify({...pilot,classification:'Policy-rejected tool execution; no implementation. Excluded from matched r2 denominator.'},null,2)+'\n');
paired.totals={baselineAstraTokens:paired.cases.reduce((s,c)=>s+c.astra.astraTokens,0),workflowAstraTokens:paired.cases.reduce((s,c)=>s+c.workflow.astraTokens,0)};
paired.totals.astraReductionPct=Number(((1-paired.totals.workflowAstraTokens/paired.totals.baselineAstraTokens)*100).toFixed(2));
await writeFile(join(out,'paired.json'),JSON.stringify(paired,null,2)+'\n');console.log(JSON.stringify(paired.totals));
