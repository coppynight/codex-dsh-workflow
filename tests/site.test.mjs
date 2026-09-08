import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const script=await readFile(new URL('../site/app.js',import.meta.url),'utf8');
const sandbox={module:{exports:{}},Intl,URL,console};vm.runInNewContext(script,sandbox);const core=sandbox.module.exports;
test('page uses explicit percent units and preserves missing values',()=>{
 const m=core.buildModel({token:{astraReductionPct:0.5,baselineAstraTokens:1000,workflowAstraTokens:995},delivery:{},cases:[],links:{}});assert.match(m.token.pctText,/0.5%/);assert.equal(m.delivery.ratioText,'待实测');
 assert.match(core.buildModel({token:{astraReductionPct:-5},delivery:{},cases:[],links:{}}).token.pctText,/-5%/);
});
test('page links and assets work under a GitHub project path',async()=>{
 const html=await readFile(new URL('../site/index.html',import.meta.url),'utf8');const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
 for(const [,id] of html.matchAll(/href="#([^"]+)"/g))assert.ok(ids.has(id),'missing anchor '+id);
 assert.ok(html.includes('node scripts/install.mjs'));assert.ok(html.includes('https://github.com/coppynight/codex-dsh-workflow'));assert.ok(!/\b(?:src|href)="\//.test(html));
});
test('published Astra totals agree with raw usage excerpts for every measured arm',async()=>{
 const json=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
 const summary=await json('../site/data/summary.json');let baseline=0,workflow=0;
 for(const id of ['log-redaction','checkpoint-store'])for(const arm of ['astra','workflow']){
  const r=await json(`../examples/results/${id}/${arm}-usage.json`);const total=r.usageEvents.reduce((s,e)=>s+e.usage.input_tokens+e.usage.output_tokens,0);
  if(arm==='astra')baseline+=total;else workflow+=total;
 }
 assert.equal(summary.token.baselineAstraTokens,baseline);assert.equal(summary.token.workflowAstraTokens,workflow);assert.equal(summary.token.astraReductionPct,Number(((1-workflow/baseline)*100).toFixed(2)));
});
