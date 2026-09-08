import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { newFixtureDir, prepareBase, cleanupBase, serviceConfig, importService } from './fixtures.mjs';

const base = newFixtureDir('empty-roots');
const work = join(base, 'work');
await prepareBase(base, ['work']);

const config = serviceConfig(base, { roots: [], model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } });
const service = await importService(config);

const healthyCatalog = () => ({
  routableProviders: ['deepseek-official'],
  groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }] }],
  failures: [],
});

test('delegation with no configured roots is rejected with configuration guidance, before any Host call', async () => {
  let calls = 0;
  service._setCatalogSourceForTests(() => { calls++; return healthyCatalog(); });
  let error = null;
  try { await service.delegate({ taskId: 'empty-roots-1', cwd: work, prompt: 'x' }); } catch (caught) { error = caught; }
  assert.ok(error, 'expected delegate to reject');
  assert.match(error.message, /No workspace roots are configured/);
  assert.match(error.message, /dsh\.workspaceRoots/);
  assert.equal(calls, 0, 'the route check must not run before the roots guard');
});

test('allowedCwd rejects every path when roots are empty', async () => {
  await assert.rejects(() => service.allowedCwd(work), /No workspace roots are configured/);
});

test('hostStatus exposes the disabled-delegation warning without failing', async () => {
  service._setCatalogSourceForTests(() => healthyCatalog());
  const status = await service.hostStatus();
  assert.equal(status.connected, true);
  assert.deepEqual(status.workspaceRoots, []);
  assert.match(status.workspaceWarning, /delegation is disabled/);
  assert.equal(status.routeProblem, undefined);
});

test.after(async () => { await cleanupBase(base); });
