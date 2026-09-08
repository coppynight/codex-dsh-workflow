import { mkdir, writeFile, readFile, open, rename, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { call, readEvents, summarize } from '../bridge/client.mjs';
import { readControl, assertNoPendingWork } from '../bridge/control.mjs';
import { allowedCwd, hostStatus } from '../bridge/service.mjs';
import { timeZone } from '../bridge/runtime.mjs';
import { parseDecision, controllerPrompt, advisorPrompt } from './protocol.mjs';
import { runCodex } from './codex.mjs';
import { costOf } from './usage.mjs';
import { accountEvents } from './dsh-accounting.mjs';
import { claimWorkspace } from './workspace.mjs';
import { loadConfig } from '../scripts/config.mjs';

async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}
export async function inspectSession(sessionId, requestId) {
  const data = await readEvents(sessionId);
  return { data, state: summarize(data.events, requestId) };
}
async function idle(sessionId) {
  const list = await call('list', {});
  const ids = new Set([sessionId]); let changed = true;
  while (changed) { changed = false; for (const row of list.items) if (ids.has(row.parentSessionId) && !ids.has(row.sessionId)) { ids.add(row.sessionId); changed = true; } }
  const control = await readControl();
  for (const id of ids) {
    const row = list.items.find(r => r.sessionId === id);
    if (!row || row.running) throw Error('Session or descendant is not proven idle');
    assertNoPendingWork(control, id);
  }
  return [...ids];
}

export async function runDsh({ cwd, task, outputDir, advisor = false, nativeMcp = false, agentPreset = 'standard', advisorLedgerDir, workspaceRegistry, deadlineMs = 600000, maxConsults = 2, onProgress = () => {} }) {
  cwd = await allowedCwd(resolve(cwd)); outputDir = resolve(outputDir);
  await mkdir(outputDir, { recursive: true });
  const recordFile = join(outputDir, 'record.json');
  const owner = await open(join(outputDir, 'owner.json'), 'wx');
  await owner.writeFile(JSON.stringify({ pid: process.pid, cwd })); await owner.close();
  const started = Date.now();
  const record = { version: 1, role: advisor ? 'dsh-advisor' : 'dsh-alone', cwd,
    sessionId: randomUUID(), requestId: randomUUID(), phase: 'preflight',
    startedAt: new Date(started).toISOString(), elapsedMs: 0, requests: [], consultations: [], usageEvents: [],
    promptSha256: createHash('sha256').update(task).digest('hex'), completed: false, idleVerified: false,
    budget: { deadlineMs, maxConsults, stopBeforeNextCallUsd: 2, hardBillingCap: false },
    excludedUsage: ['experiment development and root research session'], nativeMcp, agentPreset,
  };
  await writeFile(join(outputDir, 'task.txt'), task);
  await save(recordFile, record);
  let lastData, releaseClaim;
  try {
    const host = await hostStatus();
    if (!host.connected || !host.modelReady) throw Error('DSH Host/model is not ready; run npm run doctor');
    record.requestedModel = host.model;
    releaseClaim = await claimWorkspace({ stateDir: workspaceRegistry || loadConfig({}).dsh.stateDir, cwd, taskId: `dsh-led-${record.sessionId}`, sessionId: record.sessionId });
    record.workspaceClaim = 'held'; await save(recordFile, record);
    const rows = await call('list', {});
    if (rows.items.some(r => r.running && typeof r.cwd === 'string' && resolve(r.cwd).toLowerCase() === cwd.toLowerCase())) throw Error('Workspace has an active DSH session');
    record.phase = 'creating'; await save(recordFile, record);
    await call('create', { sessionId: record.sessionId, cwd, agentPreset });
    await call('selectModel', { sessionId: record.sessionId, provider: host.model.provider, model: host.model.model, reasoningEffort: host.model.reasoningEffort });
    let nextPrompt = controllerPrompt(task, advisor, nativeMcp);
    for (let turn = 0; turn <= maxConsults; turn++) {
      if (Date.now() - started >= deadlineMs) throw Error('Task deadline reached before next request');
      await idle(record.sessionId);
      record.requestId = randomUUID();
      record.requests.push({ requestId: record.requestId, prompt: nextPrompt, status: 'submitting' });
      record.phase = 'submitting'; record.idleVerified = false; await save(recordFile, record);
      // An ambiguous response is never retried; the saved requestId supports inspection.
      await call('prompt', { sessionId: record.sessionId, requestId: record.requestId, mode: 'queue', clientTimeZone: timeZone, content: [{ type: 'text', text: nextPrompt }] });
      record.phase = 'observing'; await save(recordFile, record);
      let state, cursor = -1;
      while (Date.now() - started < deadlineMs) {
        lastData = await readEvents(record.sessionId, 10);
        state = summarize(lastData.events, record.requestId);
        if (lastData.cursor !== cursor) { cursor = lastData.cursor; onProgress({ role: record.role, turn, state: state.state, cursor }); }
        record.accounting = accountEvents(lastData.events); record.usageEvents = record.accounting.usageEvents;
        record.actualModelEvents = lastData.events.filter(e => e.type === 'model/selection').map(e => ({ seq: e.seq, data: e.data }));
        record.cost = costOf(record.usageEvents, 'deepseek');
        record.elapsedMs = Date.now() - started;
        await save(recordFile, record);
        if (state.pendingApprovalCount || state.pendingQuestionCount) throw Error('Executor needs user input; no automatic answer is authorized');
        if (state.state !== 'running' && state.turnEnd) break;
        if (record.cost.complete && record.cost.usd >= 2) throw Error('DSH stop threshold reached');
      }
      if (state?.state !== 'completed') throw Error(`Executor stopped without completion: ${state?.state ?? 'deadline'}`);
      record.sessionTree = await idle(record.sessionId);
      record.idleVerified = true;
      const answer = state.messages?.at(-1)?.content?.map(b => b.text).join('\n') ?? '';
      record.requests.at(-1).status = 'completed';
      record.requests.at(-1).answer = answer;
      const decision = parseDecision(answer);
      record.decision = decision;
      if (decision.action !== 'consult') { record.completed = decision.action === 'complete'; record.phase = decision.action; break; }
      if (nativeMcp || !advisor || record.consultations.length >= maxConsults) throw Error('Expert consultation unavailable or exhausted');
      if (!record.cost?.complete || !record.accounting.coverageComplete) throw Error('Unknown executor cost; no new expert call');
      if (record.cost.usd + record.consultations.reduce((n,c)=>n+(c.cost?.usd ?? Infinity),0) >= 2) throw Error('Combined stop-before-next-call threshold reached');
      if (Date.now() - started >= deadlineMs) throw Error('Deadline reached before consultation');
      record.phase = 'consulting'; record.idleVerified = false; await save(recordFile, record);
      const index = record.consultations.length;
      const consultation = { index, decision, status: 'started' };
      record.consultations.push(consultation); await save(recordFile, record);
      // Deterministic relay: no parent model selects the question or adds evidence.
      const expert = await runCodex({ cwd, outputDir: join(outputDir, `expert-${index}`), role: 'advisor',
        prompt: advisorPrompt(task, decision), timeoutMs: Math.min(180000, deadlineMs - (Date.now() - started)) });
      consultation.expert = expert; consultation.cost = costOf(expert.usageEvents, 'astra');
      consultation.status = expert.exitCode === 0 && !expert.timedOut && !expert.failures.length && !expert.toolResults.length ? 'completed' : 'failed';
      await save(recordFile, record);
      if (consultation.status !== 'completed' || !consultation.cost.complete) throw Error('Expert failed or usage is unknown; no automatic retry');
      const knownCost = record.cost.usd + record.consultations.reduce((n, c) => n + (c.cost?.usd ?? 0), 0);
      if (knownCost >= 2) throw Error('Combined stop-before-next-call threshold reached');
      nextPrompt = `Expert advice follows. You retain implementation and verification responsibility. Treat the advice as fallible; verify it against actual evidence. Remaining expert consultations: ${maxConsults - record.consultations.length}. Continue the original task and finish with the same final JSON protocol.\n\n${expert.answer}`;
    }
  } catch (error) {
    record.error = error.message; record.phase = 'stopped';
    try {
      const observed = await inspectSession(record.sessionId, record.requestId); lastData = observed.data;
      if (observed.state.state === 'running') {
        record.cancel = { status: 'submitting', requestId: record.requestId }; await save(recordFile, record);
        await call('cancel', { sessionId: record.sessionId }); record.cancel.status = 'submitted';
      }
      await idle(record.sessionId); record.idleVerified = true;
    } catch { record.idleVerified = false; }
  } finally {
    if (lastData) {
      await writeFile(join(outputDir, 'private-events.json'), JSON.stringify(lastData));
      record.accounting = accountEvents(lastData.events); record.usageEvents = [...record.accounting.usageEvents];
      record.descendants = [];
      for (const childId of (record.sessionTree ?? []).filter(id => id !== record.sessionId)) {
        const childData = await readEvents(childId); const accounting = accountEvents(childData.events);
        record.descendants.push({ sessionId: childId, accounting }); record.usageEvents.push(...accounting.usageEvents);
        await writeFile(join(outputDir, `private-child-${childId}.json`), JSON.stringify(childData));
      }
      record.cost = costOf(record.usageEvents, 'deepseek');
      record.toolNames = [...new Set(lastData.events.filter(e => ['tool/call', 'tool/code-dispatch-start'].includes(e.type)).map(e => e.data?.name).filter(Boolean))];
    }
    if (nativeMcp && advisorLedgerDir) {
      const names = await readdir(advisorLedgerDir).catch(() => []);
      record.consultations = [];
      for (const file of names.filter(name => name.endsWith('.json'))) record.consultations.push(JSON.parse(await readFile(join(advisorLedgerDir, file), 'utf8')));
      if (names.includes('active.lock')) { record.idleVerified = false; record.error = 'Advisor operation is still active or unknown'; }
      record.advisorLedgerDir = advisorLedgerDir;
    }
    if (releaseClaim && record.idleVerified) { await releaseClaim(); record.workspaceClaim = 'released'; }
    record.elapsedMs = Date.now() - started; await save(recordFile, record);
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, specFile] = process.argv.slice(2);
  if (command === 'inspect') {
    const state = JSON.parse(await readFile(specFile, 'utf8'));
    const result = await inspectSession(state.sessionId, state.requestId);
    console.log(JSON.stringify({ sessionId: state.sessionId, requestId: state.requestId, ...result.state }));
  } else if (command === 'run') {
    const spec = JSON.parse(await readFile(specFile, 'utf8'));
    const result = await runDsh({ ...spec, onProgress: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify({ phase: result.phase, error: result.error, elapsedMs: result.elapsedMs, completed: result.completed, idleVerified: result.idleVerified, cost: result.cost, consultations: result.consultations.length }));
    if (!result.completed) process.exitCode = 1;
  } else throw Error('Usage: node prototype/runner.mjs run SPEC.json | inspect RECORD.json');
}
