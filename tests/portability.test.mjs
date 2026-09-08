import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const bridgeDir = join(repoRoot, 'bridge');
const implementations = ['client.mjs', 'control.mjs', 'service.mjs', 'server.mjs', 'invoke.mjs', 'probe.mjs', 'runtime.mjs', 'sanitize.mjs'];

// Machine literals that must never appear in bridge implementation code. The
// temporary scripts/config.mjs stub carries machine defaults and is replaced
// by the real config at deploy time, so it is intentionally not scanned here.
const forbidden = [
  [/D:[\\/]AI/i, 'absolute D:/AI path'],
  [/D:[\\/]workspace/i, 'absolute D:/workspace path'],
  [/dsh-codex-bridge/i, 'original deployment folder name'],
  [/127\.0\.0\.1:3080/, 'original host port'],
  [/Start-DSH/, 'original launcher name'],
  [/Asia\/Shanghai/, 'original time zone'],
  [/deepseek-official|deepseek-v4-flash/i, 'original model selection'],
  [/\bbridge-data\b/, 'original state dir name'],
  [/createRequire\(\s*['"][A-Za-z]:[\\/]/, 'createRequire with an absolute Windows path'],
];

test('bridge implementations contain no machine literals (portability guard)', async () => {
  for (const name of implementations) {
    const source = await readFile(join(bridgeDir, name), 'utf8');
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(source, pattern, `${name} must not contain ${label}`);
    }
  }
});

test('invoke.mjs resolves the server entry relative to its own module', async () => {
  const { serverModulePath } = await import('../bridge/invoke.mjs');
  assert.equal(serverModulePath(), join(bridgeDir, 'server.mjs'));
  const { stat } = await import('node:fs/promises');
  await stat(serverModulePath());
});

test('server.mjs loads and builds its tools without connecting (offline)', async () => {
  const { createServer } = await import('../bridge/server.mjs');
  const server = createServer();
  assert.ok(server && typeof server.connect === 'function', 'createServer must return a connectable MCP server');
  const second = createServer();
  assert.ok(second && typeof second.connect === 'function', 'createServer must be reusable');
});

const fixtureRoot = join(repoRoot, '.test-fixtures', `portable-${process.pid}-${Date.now()}`);
const cases = [];

test('a relocated bridge resolves config and DSH descriptors purely from its own tree', async () => {
  const relocated = join(fixtureRoot, 'repo', 'bridge');
  const scripts = join(fixtureRoot, 'repo', 'scripts');
  const fakeDsh = join(fixtureRoot, 'dsh');
  const pkg = join(fakeDsh, 'node_modules', '@deepseek-ai', 'dsh-api-session-controller');
  await mkdir(join(pkg), { recursive: true });
  await mkdir(scripts, { recursive: true });
  await mkdir(join(relocated), { recursive: true });
  await mkdir(join(fakeDsh, 'logs'), { recursive: true });

  // Minimal official-shaped descriptor package inside the fake install dir.
  await writeFile(join(fakeDsh, 'package.json'), JSON.stringify({ name: 'fake-dsh-root', version: '0.0.0', dependencies: { '@deepseek-ai/dsh': '9.9.9' } }));
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-api-session-controller', version: '1.2.3', type: 'module', exports: { './remote': './remote.mjs' } }));
  await writeFile(join(pkg, 'remote.mjs'), "export const TYPERT_REMOTE = { descriptors: [{ namespace: 'session', method: 'modelCatalog', mode: 'rpc', parameters: [], result: {} }] };\nexport default TYPERT_REMOTE;\n");

  // Copy runtime.mjs verbatim; its '../scripts/config.mjs' must resolve to the
  // relocated scripts directory, proving relative resolution is not anchored
  // to this workspace.
  await writeFile(join(relocated, 'runtime.mjs'), await readFile(join(bridgeDir, 'runtime.mjs'), 'utf8'));
  const configForCopy = {
    dsh: {
      installDir: fakeDsh,
      origin: 'http://127.0.0.1:4321',
      logPath: join(fakeDsh, 'logs', 'host.log'),
      stateDir: join(fixtureRoot, 'state'),
      workspaceRoots: [join(fixtureRoot, 'work-a')],
      model: { provider: 'acme-cloud', model: 'm2', reasoningEffort: 'low' },
    },
    timeZone: 'Europe/Paris',
  };
  await writeFile(join(scripts, 'config.mjs'), `export function loadConfig() { return ${JSON.stringify(configForCopy)}; }\n`);

  const copied = await import(pathToFileURL(join(relocated, 'runtime.mjs')).href);
  assert.equal(copied.origin, 'http://127.0.0.1:4321');
  assert.equal(copied.muxWebSocketUrl, 'ws://127.0.0.1:4321/api/remote.mux');
  assert.equal(copied.apiUrl('session/modelCatalog'), 'http://127.0.0.1:4321/api/session/modelCatalog');
  assert.equal(copied.installDir, fakeDsh);
  assert.equal(copied.logPath, join(fakeDsh, 'logs', 'host.log'));
  assert.deepEqual(copied.model, { provider: 'acme-cloud', model: 'm2', reasoningEffort: 'low' });
  assert.equal(copied.timeZone, 'Europe/Paris');
  assert.equal(copied.descriptorsAvailable(), true);
  const typert = await copied.loadDescriptors();
  assert.deepEqual(typert.descriptors.map((d) => d.method), ['modelCatalog']);
  assert.equal(await copied.readInstalledDshVersion(), '9.9.9');

  // The copied runtime contains the same machine-literal-free guarantee.
  const copiedSource = await readFile(join(relocated, 'runtime.mjs'), 'utf8');
  for (const [pattern, label] of forbidden) assert.doesNotMatch(copiedSource, pattern, `copied runtime.mjs must not contain ${label}`);
  cases.push('relocated-bridge');
});

test.after(async () => {
  if (cases.length) await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
});
