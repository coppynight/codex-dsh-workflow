import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, call, observe } from './client.mjs';
import { descriptorsAvailable } from './runtime.mjs';

// Live-Host tests are offline by default. Codex (integration owner) enables
// them with DSH_BRIDGE_ONLINE=1 against a running local DSH Host.
const online = process.env.DSH_BRIDGE_ONLINE === '1';

const event = (seq, type, data) => ({ seq, type, data });
const start = (seq, turn) => event(seq, 'turn/start', { turn });
const user = (seq, requestId) => event(seq, 'user/message', { source: { kind: 'user', rpcId: requestId }, content: [] });
const end = (seq, turn, kind) => event(seq, 'turn/end', { turn, reason: { kind } });
const message = (seq, text) => event(seq, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } });
test('missing credentials surface setup guidance without exposing raw provider errors',()=>{
  const closing=end(2,1,'error');closing.data.reason.error={code:'MISSING_CREDENTIAL',message:'api key sentinel-provider-secret'};
  const result=summarize([start(0,1),user(1,'request'),closing],'request');
  assert.equal(result.turnEnd.reason.error.code,'MISSING_CREDENTIAL');
  assert.match(result.turnEnd.reason.error.message,/Settings > Models/);
  assert.doesNotMatch(JSON.stringify(result),/sentinel-provider-secret/);
});

test('summarize: a previous completed turn cannot make a later request successful', () => {
  const events = [
    start(0, 1), user(1, 'old'), end(2, 1, 'completed'),
    start(3, 2), user(4, 'new'),
  ];
  assert.equal(summarize(events, 'new').state, 'running');
  assert.equal(summarize(events, 'missing').state, 'awaiting-admission');
});

for (const reason of ['error', 'aborted', 'blocked', 'max-tokens', 'interrupted']) {
  test(`summarize: ${reason} stays associated with its turn when a later turn completes`, () => {
    const events = [
      start(0, 1), user(1, 'one'), end(2, 1, reason),
      start(3, 2), user(4, 'two'), end(5, 2, 'completed'),
    ];
    assert.equal(summarize(events, 'one').state, reason);
    assert.equal(summarize(events, 'two').state, 'completed');
  });
}

test('summarize: steering and injected context messages do not split one turn', () => {
  const events = [
    start(0, 1), user(1, 'one'), message(2, 'initial'),
    user(3, 'steering'),
    event(4, 'user/message', { content: [{ type: 'text', text: 'runtime context' }] }),
    event(5, 'tool/call', { callId: 'test-call', name: 'test', arguments: '{}' }),
    message(6, 'final'), end(7, 1, 'completed'),
    start(8, 2), user(9, 'later'), message(10, 'another turn'), end(11, 2, 'error'),
  ];
  const first = summarize(events, 'one');
  assert.equal(first.state, 'completed');
  assert.equal(first.turnEnd.turn, 1);
  assert.deepEqual(first.messages.map((value) => value.seq), [2, 6]);
  assert.deepEqual(first.toolEvents.map((value) => value.seq), [5]);
  const steering = summarize(events, 'steering');
  assert.equal(steering.state, 'completed');
  assert.deepEqual(steering.messages.map((value) => value.seq), [6]);
});

for (const [name, events] of [
  ['missing turn start', [user(1, 'one'), end(2, 1, 'completed')]],
  ['request after an already closed turn', [start(0, 1), end(1, 1, 'completed'), user(2, 'one'), end(3, 1, 'completed')]],
  ['mismatched closing turn', [start(0, 1), user(1, 'one'), end(2, 2, 'completed')]],
  ['next turn starts before matching end', [start(0, 1), user(1, 'one'), start(2, 2), user(3, 'later'), end(4, 2, 'completed')]],
  ['invalid turn identity', [start(0, undefined), user(1, 'one'), end(2, undefined, 'completed')]],
]) {
  test(`summarize: ${name} cannot prove completion`, () => {
    assert.equal(summarize(events, 'one').state, 'unresolved-turn');
  });
}

test('summarize: only the official user source admits a request', () => {
  const events = [start(0, 1), event(1, 'user/message', { source: { kind: 'plugin', rpcId: 'one' } }), end(2, 1, 'completed')];
  assert.equal(summarize(events, 'one').state, 'awaiting-admission');
});

test('summarize: an end without its reason cannot imply success', () => {
  const events = [start(0, 1), user(1, 'one'), event(2, 'turn/end', { turn: 1 })];
  assert.equal(summarize(events, 'one').state, 'unknown-terminal');
});

test('summarize: assistant evidence reads the official message and exposes text only', () => {
  const events = [start(0, 1), user(1, 'one'), event(2, 'assistant/message', {
    turn: 1, step: 1, interrupted: true, content: [{ type: 'text', text: 'incorrect outer content' }],
    message: { role: 'assistant', content: [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: 'Public result' },
      { type: 'tool-call', name: 'write', arguments: 'large source' },
    ] },
  }), end(3, 1, 'aborted')];
  const summary = summarize(events, 'one');
  assert.deepEqual(summary.messages, [{ seq: 2, content: [{ type: 'text', text: 'Public result' }], interrupted: true }]);
  assert.doesNotMatch(JSON.stringify(summary), /private reasoning|incorrect outer content|large source/);
});

test('summarize: large native and Code Mode tool payloads have bounded public previews', () => {
  const events = [start(0, 1), user(1, 'one')];
  for (let index = 0; index < 10; index++) events.push(event(index + 2, 'tool/code-dispatch', {
    subCallId: `run:code:${index}`, name: 'write', arguments: { content: 's'.repeat(20000) },
    content: [{ type: 'text', text: 'd'.repeat(20000) }, { type: 'reasoning', text: 'hidden result reasoning' }],
    meta: { diff: 'unbounded metadata' }, isError: false,
  }));
  events.push(event(12, 'tool/result', { message: { source: { kind: 'tool', callId: 'native' }, content: [{
    type: 'tool-result', toolCallId: 'native', isError: true, content: [{ type: 'text', text: 'Test failed' }],
  }] }, error: { name: 'ToolError', code: 'FAILED' }, meta: { diff: 'unbounded metadata' } }));
  const summary = summarize(events, 'one');
  assert.equal(summary.toolEvents.length, 8);
  assert.equal(summary.toolEventsOmitted, 3);
  assert.ok(JSON.stringify(summary.toolEvents).length < 14000);
  assert.equal(summary.toolEvents[0].data.argumentsTruncated, true);
  assert.equal(summary.toolEvents[0].data.textTruncated, true);
  assert.equal(summary.toolEvents.at(-1).data.textPreview, 'Test failed');
  assert.equal(summary.toolEvents.at(-1).data.isError, true);
  assert.doesNotMatch(JSON.stringify(summary), /hidden result reasoning|unbounded metadata/);
});

test('summarize: approval decisions clear only the matching asked audit', () => {
  const events = [start(0, 1), user(1, 'one'),
    event(2, 'approval/asked', { id: 'a', toolName: 'write', reason: 'Allow this edit' }),
    event(3, 'approval/asked', { id: 'b', toolName: 'run', callId: 'run-1' }),
    event(4, 'approval/decided', { id: 'a', outcome: 'allowed-once' }),
  ];
  const summary = summarize(events, 'one');
  assert.deepEqual(summary.pendingApprovals.map((approval) => approval.id), ['b']);
  assert.deepEqual(summary.waitingFor, ['approval']);
  assert.deepEqual(summarize([...events, event(5, 'approval/decided', { id: 'b', outcome: 'cancelled' })], 'one').waitingFor, []);
});

test('summarize: unanswered native and Code Mode questions clear on official result pairs', () => {
  const args = { questions: [{ id: 'choice', question: 'Which module?', options: [{ label: 'API', description: 'Backend' }], multi_select: false }] };
  const events = [start(0, 1), user(1, 'one'),
    event(2, 'tool/call', { name: 'ask_user_question', callId: 'native', arguments: JSON.stringify(args) }),
    event(3, 'tool/code-dispatch-start', { name: 'ask_user_question', subCallId: 'run:code:1', arguments: args }),
  ];
  let summary = summarize(events, 'one');
  assert.equal(summary.pendingQuestionCount, 2);
  assert.deepEqual(summary.waitingFor, ['user-question']);
  assert.equal(summary.pendingQuestions[0].questions[0].question, 'Which module?');
  events.push(event(4, 'tool/result', { message: { source: { kind: 'tool', callId: 'native' }, content: [] } }));
  summary = summarize(events, 'one');
  assert.deepEqual(summary.pendingQuestions.map((question) => question.callId), ['run:code:1']);
  events.push(event(5, 'tool/code-dispatch', { name: 'ask_user_question', subCallId: 'run:code:1', isError: false, content: [] }));
  assert.deepEqual(summarize(events, 'one').waitingFor, []);
});

test('summarize: interrupted turns do not advertise stale questions or approvals as live', () => {
  const events = [start(0, 1), user(1, 'one'),
    event(2, 'approval/asked', { id: 'a', toolName: 'run' }),
    event(3, 'tool/call', { name: 'ask_user_question', callId: 'q', arguments: '{}' }),
    end(4, 1, 'interrupted'),
  ];
  const summary = summarize(events, 'one');
  assert.equal(summary.state, 'interrupted');
  assert.deepEqual(summary.waitingFor, []);
});

test('live Host rejects anonymous RPC and accepts the official typed call', { skip: !online }, async () => {
  const anonymous = await fetch('http://127.0.0.1:3080/api/session/modelCatalog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(anonymous.status, 401);
  const catalog = await call('modelCatalog');
  assert.ok(Array.isArray(catalog.routableProviders));
});

test('official generated input contract rejects malformed session operations before sending', { skip: !descriptorsAvailable() }, async () => {
  await assert.rejects(() => call('create', { cwd: 42 }));
  await assert.rejects(() => call('prompt', {}));
});
