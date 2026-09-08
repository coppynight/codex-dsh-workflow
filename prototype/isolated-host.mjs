import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, open, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { loadConfig } from '../scripts/config.mjs';
const [specFile] = process.argv.slice(2);
const spec = JSON.parse(await readFile(specFile, 'utf8'));
const setupStarted = Date.now();
const reasoningEffort = spec.reasoningEffort || 'high';
if (!['off','low','high','max'].includes(reasoningEffort)) throw Error('Unsupported reasoning effort');
const original = loadConfig();
const localRequire = createRequire(join(original.dsh.installDir, 'package.json'));
const yaml = localRequire('js-yaml');
const id = spec.privateId;
if (!/^[a-z0-9-]{1,100}$/.test(id || '')) throw Error('privateId required');
const privateRoot = join(process.env.LOCALAPPDATA || join(homedir(), '.local'), 'dsh-led-private', id);
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
const marker = await open(join(privateRoot, 'owner.json'), 'wx');
await marker.writeFile(JSON.stringify({ pid: process.pid, cwd: spec.cwd })); await marker.close();
const home = join(privateRoot, 'home'); await mkdir(home, { recursive: true, mode: 0o700 });
// Read only the documented native store. Copy no file and print no credential.
let settings;
try { settings = yaml.load(await readFile(join(original.dsh.homeDir, 'settings.yaml'), 'utf8')) || {}; }
catch (error) { if (error.code === 'ENOENT') settings = {}; else throw Error('Native DSH settings are unreadable; contents withheld'); }
const adapter = settings['llm-deepseek'] || {};
const ref = adapter.apiKeyEnv || 'DEEPSEEK_API_KEY';
let credentials = {};
if (!process.env[ref]) {
  try { credentials = yaml.load(await readFile(join(original.dsh.homeDir, '.credentials.yaml'), 'utf8')) || {}; }
  catch (error) { if (error.code !== 'ENOENT') throw Error('Native DSH credential store is unreadable; contents withheld'); }
}
const key = process.env[ref] || credentials.refs?.[ref] || (credentials.version === undefined ? credentials[ref] : null);
if (typeof key !== 'string' || !key) throw Error('Configured DeepSeek credential unavailable. Configure the native DSH provider first.');
const presetRoot = join(privateRoot, 'presets'), preset = join(presetRoot, 'dsh-led');
await mkdir(presetRoot, { recursive: true });
await cp(join(original.dsh.installDir, 'node_modules/@deepseek-ai/dsh-agent-presets/presets/standard'), preset, { recursive: true });
const presetText = await readFile(join(preset, 'agent.cordis.yml'), 'utf8');
const rows = [];
const advisorConfig = join(privateRoot, 'advisor-config.json');
const ledgerDir = join(privateRoot, 'advisor-ledger');
await writeFile(advisorConfig, JSON.stringify({ cwd: spec.cwd, task: spec.task, ledgerDir, maxConsults: 2 }));
if (spec.advisor) rows.push({ id: 'astra-consult-mcp', name: '@deepseek-ai/dsh-mcp-client', config: {
  transport: 'stdio', serverName: 'astra_consult', command: process.execPath,
  args: [resolve('prototype/consult-mcp.mjs'), advisorConfig], cwd: spec.cwd, env: { [ref]: '' },
  toolCallTimeoutMs: 180000, failOnStartupError: true, reconnect: { enabled: false },
} });
await writeFile(join(preset, 'agent.cordis.yml'), presetText + '\n' + (rows.length ? yaml.dump(rows) : ''));
const overlay = [
  { id: 'session-title-llm', disabled: true },
  { id: 'settings', config: { path: join(home, 'settings.yaml'), watch: false } },
  { id: 'credentials', config: { path: join(home, '.credentials.yaml'), watch: false } },
  { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
  { id: 'llm-deepseek', config: { apiKeyEnv: ref, ...(adapter.baseURL ? { baseURL: adapter.baseURL } : {}), reasoningEffort } },
  { id: 'agent-presets', config: { default: 'dsh-led', roots: [{ path: presetRoot, trust: 'user' }], includeShippedRoot: true, includeUserRoot: false } },
];
const overlayFile = join(privateRoot, 'overlay.yml'); await writeFile(overlayFile, yaml.dump(overlay));
const out = await open(join(privateRoot, 'host.stdout.log'), 'wx');
const err = await open(join(privateRoot, 'host.stderr.log'), 'wx');
const child = spawn(process.execPath, [join(original.dsh.installDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', overlayFile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: original.dsh.installDir, detached: true, windowsHide: true, stdio: ['ignore', out.fd, err.fd],
  env: { ...process.env, [ref]: key, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
});
await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail); });
child.unref(); await out.close(); await err.close();
await writeFile(join(privateRoot, 'host-process.json'), JSON.stringify({ pid: child.pid, privateRoot, startedAt: new Date().toISOString() }));
let origin;
for (let i = 0; i < 60; i++) {
  const log = await readFile(join(privateRoot, 'host.stdout.log'), 'utf8');
  const match = [...log.matchAll(/^dsh web:\s+(http:\/\/\S+)\s*$/gm)].at(-1)?.[1];
  if (match) { origin = new URL(match).origin; break; }
  await new Promise(done => setTimeout(done, 500));
}
if (!origin) throw Error(`Experimental Host did not become ready; inspect private logs at ${privateRoot}`);
const configuration = { version: 1, dsh: { ...original.dsh, homeDir: home, origin, logPath: join(privateRoot, 'host.stdout.log'), stateDir: join(privateRoot, 'bridge-state'), workspaceRoots: [spec.cwd], autoStart: false } };
configuration.dsh.model = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort };
delete configuration.dsh.port; delete configuration.dsh.hostAddr;
const workflowConfig = join(privateRoot, 'workflow-config.json'); await writeFile(workflowConfig, JSON.stringify(configuration, null, 2));
const newSpec = { ...spec, agentPreset: 'dsh-led', nativeMcp: Boolean(spec.advisor), advisorLedgerDir: ledgerDir, workflowConfig, privateRoot, hostPid: child.pid, workspaceRegistry: original.dsh.stateDir, setupElapsedMs: Date.now()-setupStarted };
await writeFile(specFile, JSON.stringify(newSpec, null, 2));
console.log(JSON.stringify({ ready: true, origin, workflowConfig, privateRoot, hostPid: child.pid, advisor: spec.advisor }));
