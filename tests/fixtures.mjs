// Offline test fixtures: every test scenario runs with its own config object
// injected through DSH_BRIDGE_CONFIG_JSON before the bridge modules are first
// imported, so tests never touch a real DSH Host, Claude, or API keys.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const repoRoot = resolve(dirname(dirname(fileURLToPath(import.meta.url))));

export function newFixtureDir(label) {
  return join(repoRoot, '.test-fixtures', `${label}-${process.pid}-${randomUUID().slice(0, 8)}`);
}

export async function prepareBase(base, subdirs = []) {
  await mkdir(base, { recursive: true });
  for (const sub of subdirs) await mkdir(join(base, sub), { recursive: true });
}

export async function cleanupBase(base) {
  await rm(base, { recursive: true, force: true }).catch(() => {});
}

export function serviceConfig(base, { roots = [], model = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }, origin = 'http://127.0.0.1:9', timeZone = 'UTC' } = {}) {
  return {
    dsh: {
      installDir: join(base, 'install'),
      origin,
      logPath: join(base, 'logs', 'host.stdout.log'),
      stateDir: join(base, 'state'),
      workspaceRoots: roots,
      model,
    },
    timeZone,
  };
}

/** Inject one config and import the bridge service (once per process). */
export async function importService(config) {
  const file=join(dirname(config.dsh.stateDir),'test-config.json');
  await writeJson(file,config);
  process.env.WORKFLOW_CONFIG = file;
  return import('../bridge/service.mjs');
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}
