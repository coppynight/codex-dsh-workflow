import test from 'node:test';
import assert from 'node:assert/strict';
import {observationView} from '../bridge/observation.mjs';
const fixture={taskId:'example',requestId:'request-1',cursor:100,state:'running',released:false,messages:[{seq:99,content:[{type:'text',text:'a'.repeat(900)}]}],toolEvents:[],pendingApprovals:[{id:'approve-1'}],pendingQuestions:[{id:'question-1'}],waitingFor:['approval']};
test('unchanged compact polling preserves blockers and identity but omits repeated content',()=>{
  const r=observationView(fixture,{detail:'summary',afterCursor:100});assert.equal(r.changed,false);assert.equal(r.requestId,'request-1');assert.deepEqual(r.pendingApprovals,fixture.pendingApprovals);assert.deepEqual(r.pendingQuestions,fixture.pendingQuestions);assert.equal(r.messages,undefined);assert.equal(r.latestMessage,undefined);assert.equal(r.released,false);
});
test('compact terminal observation always preserves correlated failure evidence',()=>{
  const full={...fixture,state:'error',turnEnd:{reason:{kind:'error',message:'provider unavailable'}},toolEvents:[{data:{isError:true,textPreview:'blocked'}}]};
  const r=observationView(full,{detail:'summary',afterCursor:98});assert.deepEqual(r.turnEnd,full.turnEnd);assert.equal(r.latestMessage.text.length,600);assert.equal(r.latestMessage.truncated,true);assert.equal(r.recentToolFailures.length,1);assert.strictEqual(observationView(full),full);
  assert.deepEqual(observationView(full,{detail:'summary',afterCursor:100}).turnEnd,full.turnEnd);
});
test('compact diagnostics and structured tool errors survive unchanged observations',()=>{
 const full={...fixture,state:'unresolved-turn',detail:'missing turn/start',toolEvents:[{data:{error:{name:'ToolError',code:'EPERM'}}}]};
 const r=observationView(full,{detail:'summary',afterCursor:100});assert.equal(r.detail,'missing turn/start');assert.equal(r.viewDetail,'summary');assert.deepEqual(r.recentToolFailures,full.toolEvents);
});
test('a new tool event does not repeat an already observed assistant message',()=>{
 const r=observationView({...fixture,cursor:101},{detail:'summary',afterCursor:100});assert.equal(r.changed,true);assert.equal(r.latestMessage,undefined);
});
