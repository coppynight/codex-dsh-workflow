import test from 'node:test';
import assert from 'node:assert/strict';
import { overlaps, claimFileName, describeModelRouteProblem, assertModelRoute } from './service.mjs';
import { assertNoPendingWork, readControl } from './control.mjs';

const online = process.env.DSH_BRIDGE_ONLINE === '1';
const windows = process.platform === 'win32';

test('workspace conflicts include aliases, ancestors and descendants, but not sibling prefixes', { skip: !windows }, () => {
  assert.equal(overlaps('D:/workspace/project', 'd:/WORKSPACE/project/src'), true);
  assert.equal(overlaps('D:/workspace/project/src', 'D:/workspace/project'), true);
  assert.equal(overlaps('D:/workspace/project', 'D:/workspace/project-copy'), false);
  assert.equal(overlaps('D:/workspace/project-a', 'D:/workspace/project-b'), false);
});

test('claim file names fold case on Windows only', () => {
  const a = 'D:/Workspace/My-Project/sub', b = 'd:/workspace/my-project/SUB';
  if (windows) {
    assert.equal(claimFileName(a), claimFileName(b));
  } else {
    assert.notEqual(claimFileName(a), claimFileName(b));
  }
});

test('release guards refuse queued work and both active job states', () => {
  assert.throws(() => assertNoPendingWork({ queues: { s: [{ id: 'q' }] }, jobs: {} }, 's'), /pending/);
  for (const status of ['running', 'stopping']) assert.throws(() => assertNoPendingWork({ queues: {}, jobs: { s: [{ status }] } }, 's'), /background/);
  assert.doesNotThrow(() => assertNoPendingWork({ queues: {}, jobs: { s: [{ status: 'completed' }, { status: 'failed' }, { status: 'killed' }] } }, 's'));
});

test('live Host supplies authoritative queue and job baseline', { skip: !online }, async () => {
  const control = await readControl();
  assert.equal(typeof control.queues, 'object');
  assert.equal(typeof control.jobs, 'object');
});

const healthyCatalog = () => ({
  default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  routableProviders: ['deepseek-official'],
  groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }] }],
  failures: [],
});
const selection = (provider, model, reasoningEffort) => ({ provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });

test('route assessment accepts a routable provider whose model is catalogued', () => {
  assert.equal(describeModelRouteProblem(healthyCatalog(), selection('deepseek-official', 'deepseek-v4-flash')), null);
  assert.doesNotThrow(() => assertModelRoute(healthyCatalog(), selection('deepseek-official', 'deepseek-v4-flash')));
});

test('route assessment defers to the Host when a routable provider ships an empty catalog', () => {
  const catalog = { routableProviders: ['empty-provider'], groups: [{ id: 'empty-provider', name: 'E', models: [] }], failures: [] };
  assert.equal(describeModelRouteProblem(catalog, selection('empty-provider', 'anything')), null);
});

test('route assessment rejects a provider that is not routable', () => {
  const problem = describeModelRouteProblem(healthyCatalog(), selection('other-provider', 'm'));
  assert.match(problem, /not routable/);
  assert.match(problem, /other-provider/);
  assert.throws(() => assertModelRoute(healthyCatalog(), selection('other-provider', 'm')), /DSH Web > Settings > Models/);
});

test('route assessment rejects a failing provider without echoing its failure message', () => {
  const catalog = {
    routableProviders: ['deepseek-official'],
    groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }] }],
    failures: [{ id: 'broken-provider', name: 'Broken', message: 'credential sk-abc123 secret leak http://x?token=zzz' }],
  };
  let error = null;
  try { assertModelRoute(catalog, selection('broken-provider', 'm')); } catch (caught) { error = caught; }
  assert.ok(error, 'expected assertModelRoute to throw');
  assert.match(error.message, /failed to load its model catalog/);
  assert.doesNotMatch(error.message, /sk-abc123|secret leak|token=zzz/);
  assert.match(error.message, /DSH Web > Settings > Models/);
});

test('route assessment rejects a model the provider does not offer', () => {
  const problem = describeModelRouteProblem(healthyCatalog(), selection('deepseek-official', 'ghost-model'));
  assert.match(problem, /ghost-model/);
  assert.match(problem, /deepseek-v4-flash/);
});
