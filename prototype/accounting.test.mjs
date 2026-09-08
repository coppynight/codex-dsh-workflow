import test from 'node:test';
import assert from 'node:assert/strict';
import { accountEvents } from './dsh-accounting.mjs';
import { dshCost, codexCost } from './usage.mjs';
const usage=n=>({inputTokens:n,outputTokens:n/10,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:n*1.1});
test('failed streaming attempt is counted once and retry adds spend',()=>{
  const raw=[
    ['turn/start',{turn:1}],['step/start',{turn:1,step:1}],
    ['assistant/chunk',{turn:1,step:1,chunk:{type:'usage',usage:usage(1000)}}],
    ['llm/retry',{turn:1,step:1}],['llm/retry-started',{turn:1,step:1}],
    ['assistant/chunk',{turn:1,step:1,chunk:{type:'usage',usage:usage(2000)}}],
    ['assistant/message',{turn:1,step:1,usage:usage(2000),message:{source:{provider:'deepseek-official',model:'deepseek-v4-flash'}}}],
    ['step/end',{turn:1,step:1}],['turn/end',{turn:1}],
  ].map(([type,data],seq)=>({type,data,seq}));
  const result=accountEvents([...raw,raw[6]]);
  assert.equal(result.coverageComplete,true);
  assert.equal(result.usageEvents[0].usage.inputTokens,3000);
  assert.equal(result.usageEvents[0].usage.outputTokens,300);
});
test('missing end cannot masquerade as complete accounting',()=>{
  assert.equal(accountEvents([{type:'turn/start',seq:0,data:{turn:1}}]).coverageComplete,false);
});

test('a retry with missing billed usage stops expansion even when later numbers exist',()=>{
  const raw=[['turn/start',{turn:1}],['step/start',{turn:1,step:1}],
    ['llm/retry',{turn:1,step:1}],['llm/retry-started',{turn:1,step:1}],
    ['assistant/message',{turn:1,step:1,usage:usage(2000),message:{source:{provider:'deepseek-official',model:'deepseek-v4-flash'}}}],
    ['step/end',{turn:1,step:1}],['turn/end',{turn:1}]].map(([type,data],seq)=>({type,data,seq}));
  const accounting=accountEvents(raw),cost=dshCost({accounting,usageEvents:accounting.usageEvents});
  assert.equal(accounting.coverageComplete,false); assert.equal(cost.complete,false);
  assert.equal(cost.usd,null); assert.ok(cost.knownPartialUsd>0);
});

test('unexpected model, unowned auxiliary usage and incomplete child never inherit Flash price',()=>{
  const accounting={coverageComplete:true,auxiliaryEvents:[],routes:[{provider:'deepseek-official',model:'deepseek-v4-flash'}]};
  const record={accounting,usageEvents:[{usage:usage(1000)}]};
  assert.equal(dshCost(record).complete,true);
  assert.equal(dshCost({...record,accounting:{...accounting,routes:[{provider:'deepseek-official',model:'deepseek-v4-pro'}]}}).complete,false);
  assert.equal(dshCost({...record,descendants:[{accounting:{coverageComplete:false}}]}).complete,false);
  assert.equal(dshCost({...record,accounting:{...accounting,auxiliaryEvents:[{}]}}).complete,false);
  assert.equal(codexCost({usageEvents:[],phase:'started'}).complete,false);
});
