import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export function isMain(url) {
  if (!process.argv[1]) return false;
  try {
    const normalize = p => process.platform === 'win32' ? realpathSync(p).toLowerCase() : realpathSync(p);
    return normalize(fileURLToPath(url)) === normalize(process.argv[1]);
  } catch { return false; }
}
export function configPath(env = process.env) {
  const file = env.WORKFLOW_CONFIG || join(homedir(), '.codex-dsh-workflow', 'config.json');
  if (!isAbsolute(file)) throw new Error('WORKFLOW_CONFIG must be an absolute path.');
  return file;
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, label) {
  if (!object(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported ${label} field; see references/setup.md. Do not store credentials here.`);
}
function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return resolve(value);
}
export function loadConfig(env = process.env) {
  const file = configPath(env);
  let raw = {};
  try { raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT' || env.WORKFLOW_CONFIG) throw new Error('Workflow configuration missing, unreadable or invalid JSON. See references/setup.md.'); }
  keys(raw, ['version', 'dsh', 'claude', 'timeZone'], 'configuration');
  if (raw.version !== undefined && raw.version !== 1) throw new Error('Unsupported configuration version.');
  const dsh = raw.dsh ?? {}, claude = raw.claude ?? {};
  keys(dsh, ['installDir', 'origin', 'homeDir', 'logPath', 'stateDir', 'workspaceRoots', 'model', 'autoStart'], 'dsh');
  keys(claude, ['executable', 'model'], 'claude');
  const base = join(homedir(), '.codex-dsh-workflow');
  const origin = dsh.origin ?? 'http://127.0.0.1:3080';
  let url;
  try { url = new URL(origin); } catch { throw new Error('dsh.origin must be a loopback HTTP origin.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('dsh.origin must be http://127.0.0.1:PORT with no token or path.');
  const roots = dsh.workspaceRoots ?? [];
  if (!Array.isArray(roots)) throw new Error('dsh.workspaceRoots must be an array.');
  if (dsh.autoStart !== undefined && typeof dsh.autoStart !== 'boolean') throw new Error('dsh.autoStart must be boolean.');
  const model = dsh.model ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' };
  keys(model, ['provider', 'model', 'reasoningEffort'], 'dsh.model');
  for (const field of ['provider', 'model']) if (typeof model[field] !== 'string' || !model[field].trim()) throw new Error(`dsh.model.${field} is required.`);
  if (model.reasoningEffort !== undefined && (typeof model.reasoningEffort !== 'string' || !model.reasoningEffort.trim())) throw new Error('dsh.model.reasoningEffort must be a non-empty string.');
  const reviewModel = claude.model ?? 'claude-opus-5';
  if (!/^claude-[a-z0-9.-]+$/.test(reviewModel)) throw new Error('claude.model must be an exact Claude model ID, not a moving alias.');
  const executable = claude.executable ?? (process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (typeof executable !== 'string' || !executable || (!isAbsolute(executable) && !/^[a-zA-Z0-9._-]+$/.test(executable))) throw new Error('claude.executable must be an absolute executable path or a bare command name.');
  const timeZone = raw.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new Error('Invalid timeZone.'); }
  return {
    version: 1, file, timeZone,
    dsh: {
      installDir: absolute(dsh.installDir ?? join(base, 'runtime'), 'dsh.installDir'),
      origin: url.origin, port: Number(url.port || 80), hostAddr: url.hostname,
      homeDir: absolute(dsh.homeDir ?? join(base, 'dsh-home'), 'dsh.homeDir'),
      logPath: absolute(dsh.logPath ?? join(base, 'logs', 'host.stdout.log'), 'dsh.logPath'),
      stateDir: absolute(dsh.stateDir ?? join(base, 'bridge-state'), 'dsh.stateDir'),
      workspaceRoots: roots.map(value => absolute(value, 'workspace root')),
      autoStart: dsh.autoStart ?? false, model
    },
    claude: { executable, model: reviewModel }
  };
}
