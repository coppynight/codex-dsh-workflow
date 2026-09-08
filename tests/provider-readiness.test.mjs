import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { newFixtureDir, prepareBase, cleanupBase, serviceConfig, importService } from './fixtures.mjs';

// The configured model targets a provider that is missing/failing on the Host.
// hostStatus must report that honestly and delegate must reject BEFORE any
// claim/record is created, with actionable (key-free) guidance.
const base = newFixtureDir('readiness');
const work = join(base, 'work');
const project = join(work, 'proj');
await prepareBase(base, ['work/proj']);

const config = serviceConfig(base, { roots: [work], model: { provider: 'missing-provider', model: 'deepseek-v4-flash', reasoningEffort: 'high' } });
const service = await importService(config);

const SECRET_TEXT = 'credential sk-super-secret api key abc http://127.0.0.1:9/?token=zzz';
const failingCatalog = () => ({
  default: { provider: 'missing-provider', model: 'deepseek-v4-flash' },
  routableProviders: ['deepseek-official'],
  groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }] }],
  failures: [{ id: 'missing-provider', name: 'Missing Provider', message: SECRET_TEXT }],
});

async function capture(fn) {
  try { await fn(); } catch (error) { return error; }
  return null;
}

test('hostStatus reports the broken provider route honestly without echoing provider errors', async () => {
  service._setCatalogSourceForTests(() => failingCatalog());
  const status = await service.hostStatus();
  assert.equal(status.connected, true);
  assert.deepEqual(status.model, { provider: 'missing-provider', model: 'deepseek-v4-flash', reasoningEffort: 'high' });
  assert.match(status.routeProblem, /missing-provider/);
  assert.deepEqual(status.providerFailures, [{ id: 'missing-provider', name: 'Missing Provider' }]);
  assert.ok(!('message' in status.providerFailures[0]), 'provider failure payload must not include the raw message');
  assert.doesNotMatch(JSON.stringify(status), /sk-super-secret|token=zzz|api key abc/);
});

test('hostStatus reports disconnection honestly when the Host is unreachable', async () => {
  service._setCatalogSourceForTests(() => { throw new Error('connection refused by the local Host'); });
  const status = await service.hostStatus();
  assert.equal(status.connected, false);
  assert.match(status.reason, /connection refused/);
});

test('delegate rejects a new task when the configured provider is not routable, before any claim', async () => {
  let calls = 0;
  service._setCatalogSourceForTests(() => { calls++; return failingCatalog(); });
  const error = await capture(() => service.delegate({ taskId: 'readiness-reject-1', cwd: project, prompt: 'must not be admitted' }));
  assert.ok(error, 'expected delegate to reject');
  assert.match(error.message, /missing-provider/);
  assert.match(error.message, /DSH Web > Settings > Models/);
  assert.doesNotMatch(error.message, /sk-super-secret|token=zzz|api key abc/);
  assert.equal(calls, 1, 'route check must be the only Host call before rejection');
  await assert.rejects(() => readdir(join(base, 'state', 'claims')), { code: 'ENOENT' });
  await assert.rejects(() => readdir(join(base, 'state', 'tasks')), { code: 'ENOENT' });
});

test('delegate rejects when the configured provider failed to load its catalog', async () => {
  service._setCatalogSourceForTests(() => failingCatalog());
  const error = await capture(() => service.delegate({ taskId: 'readiness-reject-2', cwd: project, prompt: 'must not be admitted' }));
  assert.ok(error, 'expected delegate to reject');
  assert.match(error.message, /failed to load its model catalog/);
  assert.doesNotMatch(error.message, /sk-super-secret|token=zzz/);
});

test('delegate does not auto-correct the configured provider/model', async () => {
  service._setCatalogSourceForTests(() => failingCatalog());
  const error = await capture(() => service.delegate({ taskId: 'readiness-reject-3', cwd: project, prompt: 'x' }));
  assert.ok(error, 'expected delegate to reject');
  // The error is about the CONFIGURED route; it never silently substitutes deepseek-official.
  assert.match(error.message, /missing-provider/);
  assert.doesNotMatch(error.message, /switched|falling back|selected deepseek-official/);
});

test.after(async () => { await cleanupBase(base); });
