import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision, controllerPrompt } from './protocol.mjs';
import { costOf } from './usage.mjs';
test('bounded protocol distinguishes advice requests from completion', () => {
  assert.equal(parseDecision('```json\n{"action":"consult","question":"which invariant?","context":"observed trace"}\n```').action,'consult');
  assert.throws(()=>parseDecision('{"action":"consult","question":"","context":"x"}'));
  assert.throws(()=>parseDecision('{"action":"consult","question":"q","context":"'+ 'x'.repeat(12001)+'"}'));
  assert.throws(()=>parseDecision('successful, trust me'));
  assert.equal(parseDecision('{"action":"complete","summary":"tests run"}').summary,'tests run');
});
test('native tool prompt does not claim an unavailable relay or old architect',()=>{
  const prompt=controllerPrompt('fix a bug',true,true);
  assert.match(prompt,/mcp__astra_consult__consult_astra/);
  assert.doesNotMatch(prompt,/Codex is the primary architect|No external expert|stop work and return/);
});
test('cost keeps missing evidence unknown and avoids cached-input double count',()=>{
  assert.equal(costOf([],'astra').usd,null);
  assert.equal(costOf([{usage:{input_tokens:10,cached_input_tokens:5,output_tokens:1}}],'astra').complete,false);
  const actual=costOf([{usage:{input_tokens:100,cached_input_tokens:80,output_tokens:10,cache_write_input_tokens:0}}],'astra');
  assert.ok(Math.abs(actual.usd-0.00078)<1e-12);
  assert.equal(costOf([{usage:{inputTokens:10,cacheReadTokens:10,outputTokens:2,totalTokens:12}}],'deepseek').complete,false);
});
