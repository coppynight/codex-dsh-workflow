import { mkdir, readFile, writeFile, rename, open, unlink, realpath, stat, readdir } from 'node:fs/promises';
import { isAbsolute, resolve, relative, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { call, readEvents, summarize } from './client.mjs';
import { readControl, assertNoPendingWork } from './control.mjs';
import { origin as hostOrigin, stateDir as configStateDir, configuredRoots,
  model as configuredModel, timeZone as configuredTimeZone, readInstalledDshVersion } from './runtime.mjs';
import { MODEL_GUIDANCE, localErrorMessage } from './sanitize.mjs';
import { observationView } from './observation.mjs';

const stateRoot = configStateDir;
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const recordPath = (id) => { if (!idPattern.test(id)) throw new Error('Invalid taskId.'); return join(stateRoot, 'tasks', `${id}.json`); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
// Claim files are keyed case-insensitively on Windows only, where two paths
// that differ only by case name the same directory.
const claimKey = (cwd) => process.platform === 'win32' ? cwd.toLowerCase() : cwd;
export function claimFileName(cwd) { return hash(claimKey(cwd)) + '.json'; }
const claimPath = (cwd) => join(stateRoot, 'claims', claimFileName(cwd));
const workerContent = (prompt) => [{ type: 'text', text: 'Coordination contract: Codex is the primary architect and environment/integration-test owner. You implement only the requested paths. Self-test within available permissions. On a Windows sandbox EPERM involving child-process capture, report the blocked check and return control promptly; do not repeatedly retry or request wider access for integration tests. Codex will run those tests. Do not read unrelated credentials or create background work.\n\n' + prompt }];
async function save(record) {
  await mkdir(join(stateRoot, 'tasks'), { recursive: true });
  const path = recordPath(record.taskId), tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2)); await rename(tmp, path);
}
async function load(taskId) { return JSON.parse(await readFile(recordPath(taskId), 'utf8')); }

/** Canonicalize every configured workspace root so symlinked cwds cannot escape. */
async function canonicalRoots() {
  const roots = [];
  for (const root of configuredRoots) {
    let actual;
    try { actual = await realpath(root); }
    catch { throw new Error(`Configured workspace root "${root}" (the user configuration dsh.workspaceRoots) does not exist or is not readable; fix or remove it.`); }
    if (!(await stat(actual)).isDirectory()) {
      throw new Error(`Configured workspace root "${root}" (the user configuration dsh.workspaceRoots) is not a directory; fix or remove it.`);
    }
    roots.push(actual);
  }
  return roots;
}

/** Resolve a cwd against the canonicalized allowed roots. */
export async function allowedCwd(cwd) {
  if (!isAbsolute(cwd)) throw new Error('cwd must be absolute.');
  let actual;
  try { actual = await realpath(cwd); }
  catch { throw new Error('cwd does not exist.'); }
  if (!(await stat(actual)).isDirectory()) throw new Error('cwd must be a directory.');
  const roots = await canonicalRoots();
  if (roots.length === 0) {
    throw new Error('No workspace roots are configured (the user configuration dsh.workspaceRoots is empty). Add the projects DSH may work in, then retry delegation.');
  }
  const contained = roots.some((root) => {
    const rel = relative(root, actual);
    return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel));
  });
  if (!contained) {
    throw new Error(`Use a project below an allowed workspace root (${configuredRoots.join(', ')}), or add the project to the user configuration dsh.workspaceRoots.`);
  }
  return actual;
}

export function overlaps(a, b) {
  const inside = (base, target) => {
    const rel = relative(resolve(base), resolve(target));
    return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}
async function acquireClaim(record) {
  return withLock('workspace-registry', async () => {
    await mkdir(join(stateRoot, 'claims'), { recursive: true });
    for (const file of await readdir(join(stateRoot, 'claims'))) {
      const owner = JSON.parse(await readFile(join(stateRoot, 'claims', file), 'utf8'));
      if (overlaps(owner.cwd, record.cwd)) throw new Error('Another DSH task owns this workspace or an overlapping directory. Check/release it or use a separate worktree.');
    }
    await writeFile(claimPath(record.cwd), JSON.stringify({ taskId: record.taskId, sessionId: record.sessionId, cwd: record.cwd }), { flag: 'wx' });
  });
}
async function assertClaim(record) {
  if (record.released) throw new Error('Workspace claim was released. Start a new task for new work.');
  const owner = JSON.parse(await readFile(claimPath(record.cwd), 'utf8'));
  if (owner.taskId !== record.taskId) throw new Error('Workspace claim ownership mismatch.');
}

/**
 * Pure route assessment for the configured model against a live catalog.
 * Returns a short problem description or null when the route is usable.
 * Provider failure messages are never echoed (they may embed credentials).
 */
export function describeModelRouteProblem(catalog, selection) {
  const provider = selection.provider, model = selection.model;
  const failing = (catalog.failures || []).find((failure) => failure.id === provider);
  if (failing) return `Provider "${provider}" is configured, but DSH reports it failed to load its model catalog.`;
  const routable = catalog.routableProviders || [];
  if (!routable.includes(provider)) {
    const others = routable.length ? routable.join(', ') : 'none';
    return `Provider "${provider}" is not routable on this DSH Host (routable providers: ${others}).`;
  }
  const group = (catalog.groups || []).find((entry) => entry.id === provider);
  if (group && Array.isArray(group.models) && group.models.length && !group.models.some((entry) => entry.id === model)) {
    return `Model "${model}" is not offered by provider "${provider}" on this DSH Host (available: ${group.models.map((entry) => entry.id).join(', ')}).`;
  }
  return null;
}

/** Throw with actionable (key-free) guidance when the configured route is unusable. */
export function assertModelRoute(catalog, selection) {
  const problem = describeModelRouteProblem(catalog, selection);
  if (problem) throw new Error(`${problem} ${MODEL_GUIDANCE}`);
}

/** Catalog source seam; production uses the authenticated Host RPC. */
let catalogSource = () => call('modelCatalog');
export function _setCatalogSourceForTests(source) { catalogSource = source; }

async function assertHostReadyForDelegation() {
  let catalog;
  try { catalog = await catalogSource(); }
  catch (error) { throw new Error(`DSH Host is not ready for delegation: ${localErrorMessage(error)}`); }
  assertModelRoute(catalog, configuredModel);
}

export async function hostStatus() {
  const dshVersion = await readInstalledDshVersion().catch(() => null);
  let catalog;
  try { catalog = await catalogSource(); }
  catch (error) {
    return { connected: false, host: hostOrigin, dshVersion, model: configuredModel, modelReady: false, reason: localErrorMessage(error) };
  }
  const routeProblem = describeModelRouteProblem(catalog, configuredModel);
  const status = {
    connected: true, host: hostOrigin, dshVersion, model: configuredModel, modelReady: !routeProblem,
    readinessScope: 'catalog-only; credentials, quota and real model execution remain unverified',
    routableProviders: catalog.routableProviders || [],
    providerFailures: (catalog.failures || []).map((failure) => ({ id: failure.id, name: failure.name })),
    workspaceRoots: configuredRoots, claimsAreCooperative: true,
  };
  if (routeProblem) status.routeProblem = routeProblem;
  if (!configuredRoots.length) status.workspaceWarning = 'No workspace roots are configured; delegation is disabled until the user configuration dsh.workspaceRoots lists allowed projects.';
  return status;
}
export async function status(taskId, seconds = 0, requestId, view = {}) {
  const record = await load(taskId);
  const data = await readEvents(record.sessionId, seconds);
  return observationView({ taskId, sessionId: record.sessionId, cwd: record.cwd, released: !!record.released,
    phase: record.phase, cursor: data.cursor, ...summarize(data.events, requestId || record.requestId),
    observationNote: 'Only a completed turn associated with this requestId indicates model completion. Independently verify files/tests.' }, view);
}
async function delegateUnlocked({ taskId, cwd, prompt }) {
  recordPath(taskId);
  const actual = await allowedCwd(cwd);
  let record;
  try { record = await load(taskId); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (record) {
    if (record.cwd !== actual || record.promptHash !== hash(prompt)) throw new Error('taskId already names different work.');
    if (!['creating', 'setup-failed'].includes(record.phase)) return await status(taskId);
    await assertClaim(record);
  }
  await assertHostReadyForDelegation();
  if (!record) {
    record = { taskId, sessionId: randomUUID(), requestId: randomUUID(), cwd: actual, promptHash: hash(prompt), phase: 'creating', operations: {}, createdAt: new Date().toISOString() };
    await acquireClaim(record); await save(record);
  }
  const { sessionId, requestId } = record;
  try {
    const list = await call('list', {});
    if (!list.items.some((row) => row.sessionId === sessionId)) await call('create', { sessionId, cwd: actual, agentPreset: 'standard' });
    const history = await readEvents(sessionId);
    if (history.events.some((e) => e.type === 'user/message' || e.type === 'turn/start')) throw new Error('Setup recovery found admitted work; inspect the session manually.');
    assertNoPendingWork(await readControl(), sessionId);
    await call('selectModel', { sessionId, provider: configuredModel.provider, model: configuredModel.model, ...(configuredModel.reasoningEffort ? { reasoningEffort: configuredModel.reasoningEffort } : {}) });
  } catch (error) { record.phase = 'setup-failed'; await save(record); throw error; }
  record.phase = 'submitting'; await save(record);
  await call('prompt', { sessionId, requestId, mode: 'queue', clientTimeZone: configuredTimeZone, content: workerContent(prompt) });
  record.phase = 'submitted'; await save(record);
  return { taskId, sessionId, requestId, state: 'submitted', cwd: actual, next: 'Call dsh_wait with this taskId. Do not edit its cwd while DSH runs.' };
}
async function followupUnlocked({ taskId, operationId, prompt }) {
  if (!idPattern.test(operationId)) throw new Error('Invalid operationId.');
  const record = await load(taskId); await assertClaim(record);
  record.operations = Object.assign(Object.create(null), record.operations || {});
  if (record.operationId && !record.operations[record.operationId]) record.operations[record.operationId] = { requestId: record.requestId, promptHash: record.followupHash };
  const previous = record.operations[operationId];
  if (previous) { if (previous.promptHash !== hash(prompt)) throw new Error('operationId already used for different work.'); return status(taskId, 0, previous.requestId); }
  const current = await status(taskId);
  if (!['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted'].includes(current.state)) throw new Error('Previous request has no proven terminal state. Check status instead of queuing duplicate work.');
  assertNoPendingWork(await readControl(), record.sessionId);
  record.requestId = randomUUID(); record.operations[operationId] = { requestId: record.requestId, promptHash: hash(prompt) }; record.phase = 'submitting'; await save(record);
  await call('prompt', { sessionId: record.sessionId, requestId: record.requestId, mode: 'queue', clientTimeZone: configuredTimeZone, content: workerContent(prompt) });
  record.phase = 'submitted'; await save(record);
  return { taskId, sessionId: record.sessionId, requestId: record.requestId, state: 'submitted' };
}
async function cancelUnlocked(taskId) {
  const record = await load(taskId); await assertClaim(record);
  return { taskId, ...await call('cancel', { sessionId: record.sessionId }), note: 'Cancels the active turn only. Does not clear pending inbox or kill separate background jobs.' };
}
async function releaseUnlocked(taskId) {
  const record = await load(taskId); if (record.released) return { taskId, released: true };
  await assertClaim(record);
  const list = await call('list', {});
  const row = list.items.find((item) => item.sessionId === record.sessionId);
  const setupOnly = ['creating', 'setup-failed'].includes(record.phase);
  if (row) {
    if (row.running) throw new Error('Cannot release a running session.');
    const history = await readEvents(record.sessionId);
    if (setupOnly) { if (history.events.some((e) => e.type === 'user/message' || e.type === 'turn/start')) throw new Error('Setup session contains admitted work; inspect manually.'); }
    else if (!['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted'].includes(summarize(history.events, record.requestId).state)) throw new Error('Cannot release without a proven terminal request.');
  } else if (!setupOnly) throw new Error('Session absent; cannot prove it is idle.');
  assertNoPendingWork(await readControl(), record.sessionId);
  await withLock('workspace-registry', async () => { await assertClaim(record); await unlink(claimPath(record.cwd)); record.released = true; await save(record); });
  return { taskId, released: true, sessionId: record.sessionId };
}

async function withTaskLock(taskId, operation) {
  recordPath(taskId);
  return withLock('task-' + taskId, operation);
}
async function withLock(lockId, operation) {
  await mkdir(join(stateRoot, 'locks'), { recursive: true });
  const path = join(stateRoot, 'locks', lockId + '.lock');
  const lock = await open(path, 'wx').catch((error) => { if (error.code === 'EEXIST') throw new Error('Another operation holds this task lock. Inspect task status; do not resubmit new work.'); throw error; });
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await operation(); }
  finally { await lock.close(); await unlink(path); }
}
export const delegate = (args) => withTaskLock(args.taskId, () => delegateUnlocked(args));
export const followup = (args) => withTaskLock(args.taskId, () => followupUnlocked(args));
export const cancel = (taskId) => withTaskLock(taskId, () => cancelUnlocked(taskId));
export const release = (taskId) => withTaskLock(taskId, () => releaseUnlocked(taskId));
