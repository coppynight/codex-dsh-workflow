import test from 'node:test';
import assert from 'node:assert/strict';
import { accountEvents } from './dsh-accounting.mjs';
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
