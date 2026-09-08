import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {astraCost,astraCredits,dshCost,capacityScenario} from '../examples/budget-v3/cost.mjs';
test('cost weights cached and output tokens without duplicating reasoning',()=>{
 const events=[{usage:{input_tokens:2000000,cached_input_tokens:1000000,cache_write_input_tokens:0,output_tokens:1000000,reasoning_output_tokens:700000}}];
 assert.equal(astraCost(events),61);assert.equal(astraCredits(events),1525);
 const dsh=[{usage:{inputTokens:1000000,cacheReadTokens:1000000,outputTokens:1000000,reasoningTokens:700000,totalTokens:3000000}}];
 assert.equal(dshCost(dsh,false),0.887);assert.equal(dshCost(dsh,true),1.774);
});
test('public stage ledger, site totals and frozen inputs agree',async()=>{
 const json=async p=>JSON.parse(await readFile(new URL('../examples/budget-v3/'+p,import.meta.url),'utf8'));
 const result=await json('results/summary.json'),plan=await json('results/plan-record.json');
 for(const arm of ['a','b']){
  const review=await json('results/'+arm+'/review-record.json');
  let astra=astraCost(plan.usageEvents)+astraCost(review.usageEvents);
  if(arm==='a')astra+=astraCost((await json('results/a/implement-record.json')).usageEvents);
  assert.equal(result[arm].astraUSD,astra);
  const dsh=arm==='b'?dshCost((await json('results/b/dsh-record.json')).usageEvents,true):0;
  assert.equal(result[arm].totalUSD,astra+dsh);
  const ledger=await json('results/interventions.json');assert.equal(result[arm].humanRequests,ledger[arm].requiredHumanRequests);
 }
 for(const f of (await json('results/freeze.json')).files)assert.equal(createHash('sha256').update(await readFile(new URL('../examples/budget-v3/'+f.path,import.meta.url))).digest('hex'),f.sha256);
 const site=JSON.parse(await readFile(new URL('../site/data/budget.json',import.meta.url),'utf8'));assert.deepEqual(site,result);
 assert.equal(result.b.processContractCompliant,false);assert.equal(result.observedSubscriptionCapacityRatio,null);assert.equal(result.humanReductionPct,null);
});
test('site capacity scenarios include overhead and are conditional',async()=>{
 const sandbox={module:{exports:{}}};vm.runInNewContext(await readFile(new URL('../site/economics.js',import.meta.url),'utf8'),sandbox);
 assert.equal(sandbox.module.exports.scenario(80,0).factor,5.000000000000001);
 assert.equal(sandbox.module.exports.scenario(75,5).retained,0.3);
});
test('unknown or inconsistent ledgers cannot look free',()=>{
 assert.throws(()=>astraCost([{usage:{}}]));assert.throws(()=>dshCost([{usage:{inputTokens:1,outputTokens:1,totalTokens:5}}],false));
 assert.throws(()=>astraCost([]));assert.throws(()=>dshCost([],false));
 assert.throws(()=>astraCost([{usage:{cache_write_input_tokens:1}}]));
 assert.equal(capacityScenario(0.2),5);assert.equal(capacityScenario(0.1,0.5),5);assert.throws(()=>capacityScenario(0));
});
