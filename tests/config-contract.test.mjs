import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../bridge/runtime.mjs';

const base = () => ({
  dsh: {
    installDir: join(tmpdir(),'dshenv','install'),
    origin: 'http://127.0.0.1:3080',
    logPath: join(tmpdir(),'dshenv','logs','host.stdout.log'),
    stateDir: join(tmpdir(),'dshenv','bridge-data'),
    workspaceRoots: [join(tmpdir(),'work','a'), join(tmpdir(),'work','b')],
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
  },
  timeZone: 'Asia/Shanghai',
});

test('validateConfig accepts the loadConfig contract shape and derives URLs', () => {
  const r = validateConfig(base());
  assert.equal(r.origin, 'http://127.0.0.1:3080');
  assert.equal(r.muxWebSocketUrl, 'ws://127.0.0.1:3080/api/remote.mux');
  assert.equal(r.apiUrl('session/modelCatalog'), 'http://127.0.0.1:3080/api/session/modelCatalog');
  assert.equal(r.installDir, join(tmpdir(),'dshenv','install'));
  assert.equal(r.logPath, join(tmpdir(),'dshenv','logs','host.stdout.log'));
  assert.equal(r.stateDir, join(tmpdir(),'dshenv','bridge-data'));
  assert.deepEqual(r.configuredRoots, [join(tmpdir(),'work','a'), join(tmpdir(),'work','b')]);
  assert.deepEqual(r.model, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' });
  assert.equal(r.timeZone, 'Asia/Shanghai');
});

test('validateConfig honors a different port, model, and time zone (no machine pinning)', () => {
  const config = base();
  config.dsh.origin = 'http://127.0.0.1:4321';
  config.dsh.model = { provider: 'acme-cloud', model: 'm2', reasoningEffort: 'low' };
  config.timeZone = 'Europe/Paris';
  const r = validateConfig(config);
  assert.equal(r.origin, 'http://127.0.0.1:4321');
  assert.equal(r.muxWebSocketUrl, 'ws://127.0.0.1:4321/api/remote.mux');
  assert.deepEqual(r.model, { provider: 'acme-cloud', model: 'm2', reasoningEffort: 'low' });
  assert.equal(r.timeZone, 'Europe/Paris');
});

test('validateConfig treats reasoningEffort as optional', () => {
  const config = base();
  delete config.dsh.model.reasoningEffort;
  assert.equal(validateConfig(config).model.reasoningEffort, undefined);
});

for (const [label, build, match] of [
  ['non-object config', () => null, /loadConfig\(\) must return an object/],
  ['missing dsh', (c) => { delete c.dsh; return c; }, /dsh.*is missing/],
  ['missing model', (c) => { delete c.dsh.model; return c; }, /dsh\.model.*is missing/],
  ['empty model provider', (c) => { c.dsh.model.provider = ''; return c; }, /dsh\.model\.provider/],
  ['empty model id', (c) => { c.dsh.model.model = ''; return c; }, /dsh\.model\.model/],
  ['invalid time zone value', (c) => { c.timeZone = ''; return c; }, /timeZone/],
  ['https origin', (c) => { c.dsh.origin = 'https://127.0.0.1:3080'; return c; }, /dsh\.origin/],
  ['non-loopback origin', (c) => { c.dsh.origin = 'http://localhost:3080'; return c; }, /dsh\.origin/],
  ['origin with token query', (c) => { c.dsh.origin = 'http://127.0.0.1:3080/?token=abc'; return c; }, /dsh\.origin/],
  ['origin with port but path', (c) => { c.dsh.origin = 'http://127.0.0.1:3080/api'; return c; }, /dsh\.origin/],
  ['relative installDir', (c) => { c.dsh.installDir = 'relative/dsh'; return c; }, /dsh\.installDir/],
  ['relative stateDir', (c) => { c.dsh.stateDir = 'bridge-data'; return c; }, /dsh\.stateDir/],
  ['relative logPath', (c) => { c.dsh.logPath = 'logs/x.log'; return c; }, /dsh\.logPath/],
  ['non-array workspaceRoots', (c) => { c.dsh.workspaceRoots = join(tmpdir(),'work'); return c; }, /dsh\.workspaceRoots/],
  ['relative workspaceRoot', (c) => { c.dsh.workspaceRoots = [join(tmpdir(),'work'), 'relative']; return c; }, /dsh\.workspaceRoots/],
]) {
  test(`validateConfig rejects ${label}`, () => {
    const config = build(base());
    assert.throws(() => validateConfig(config), match);
  });
}
