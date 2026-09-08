/**
 * dsh-recover.test.mjs - dependency-injected tests for dsh-recover.mjs.
 *
 * Every test replaces the runtime (probeHost/inspect/guardedStart/probeTask/
 * isAlive/sleep/now) with fakes, so NO subprocesses are spawned, no DSH host
 * is touched and no real fault injection happens (we are running on the host
 * this helper manages).  State directories live under this workspace only.
 *
 * Scenarios covered:
 *   1. already healthy -> no start, no inspection
 *   2. healthy + --task-id exposes only the agreed checkpoint fields
 *   3. stopped -> started -> healthy (exactly one guarded start, recovered)
 *   4. foreign 3080 listener -> blocked, never replaced, no start
 *   5. matching DSH process alive but not ready -> no duplicate start
 *   6. failed starts -> circuit opens after 3; cooldown call starts nothing;
 *      a healthy read-only probe closes the circuit early
 *   7. task status failure -> host health/circuit untouched (exit 4)
 *   8. recovery lock held by a live process -> busy (no probe/start)
 *   9. stale lock (holder proven dead, same host) is recovered
 *  10. stale lock on another host is NOT stolen -> busy
 *  11. lock release only removes the lock whose nonce matches
 *  12. redaction hides token-like values
 *  13. CLI parsing (defaults, overrides, usage errors)
 *  14. probe/task parsing units (classifyHostProbe, pickCheckpoint)
 *  15. task requested during cooldown -> no start, no task probe
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  DEFAULTS, parseCliArgs, runRecovery, acquireRecoveryLock, releaseRecoveryLock,
  redact, classifyHostProbe, pickCheckpoint, normalizeInspection,
} from '../scripts/dsh-recover.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const emptyInspection = () => ({
  ok: true, listenerPresent: false, listenerPids: [], dshPresent: false,
  dshPids: [], primaryPid: null, primaryStartEpochMs: null,
  ownsListener: false, foreignListener: false,
});

const healthyProbe = { ok: true, inner: { connected: true } };
const downProbe = { ok: false, reason: 'DSH has not announced readiness' };

function fakeRuntime(overrides = {}) {
  const calls = { probe: 0, inspect: 0, start: 0, task: 0, sleeps: [] };
  const runtime = {
    now: overrides.now ?? (() => Date.now()),
    sleep: overrides.sleep ?? (async ms => { calls.sleeps.push(ms); }),
    isAlive: overrides.isAlive ?? (async () => false),
    probeHost: overrides.probeHost ?? (async () => { calls.probe++; return downProbe; }),
    inspect: overrides.inspect ?? (async () => { calls.inspect++; return emptyInspection(); }),
    guardedStart: overrides.guardedStart ?? (async () => { calls.start++; return { ok: true, started: true, detail: 'start issued' }; }),
    probeTask: overrides.probeTask ?? (async taskId => { calls.task++; return { ok: true, checkpoint: { taskId } }; }),
  };
  return { runtime, calls };
}

function makeStateDir() {
  return mkdtempSync(join(here, '.dshr-test-'));
}

function readState(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, DEFAULTS.stateFile), 'utf8'));
}

function writeLockFile(stateDir, content) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, DEFAULTS.lockFile), JSON.stringify(content), 'utf8');
}

const lockPathFor = stateDir => join(stateDir, DEFAULTS.lockFile);

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) {
    const actual = realpathSync(dir);
    const rel = relative(realpathSync(here), actual);
    assert.ok(rel.startsWith('.dshr-test-') && !isAbsolute(rel) && !rel.includes('/') && !rel.includes('\\'), 'Cleanup must remain within generated test directory');
    rmSync(actual, { recursive: true, force: true });
  }
});

/* 1. already healthy -> no start, no inspection --------------------------------- */
test('already healthy: exit 0, no start, no inspection, counters reset', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  const { runtime, calls } = fakeRuntime({ probeHost: async () => { calls.probe++; return healthyProbe; } });
  const outcome = await runRecovery(runtime, { stateDir });
  assert.equal(outcome.status, 'healthy');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.host.healthy, true);
  assert.equal(outcome.host.recovered, false);
  assert.equal(calls.probe, 1);
  assert.equal(calls.inspect, 0);
  assert.equal(calls.start, 0);
  assert.equal(calls.task, 0);
  const state = readState(stateDir);
  assert.equal(state.consecutiveHostFailures, 0);
  assert.equal(state.circuitOpen, false);
  assert.equal(state.lastHostHealthy, true);
  assert.equal(state.lastRecovered, false);
  assert.ok(existsSync(lockPathFor(stateDir)) === false, 'lock released');
});

/* 2. healthy + task id -> checkpoint exposes only agreed fields ----------------- */
test('healthy with --task-id exposes task/session/request/cursor/phase/state/waitingFor only', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  const inner = {
    taskId: 'task-42', sessionId: 'session-x', requestId: 'req-y', phase: 'submitted',
    cursor: 17, state: 'running', waitingFor: ['approval'],
    cwd: 'D:/workspace/somewhere', messages: [{ content: 'SECRET EVIDENCE' }], // must not leak
  };
  const { runtime, calls } = fakeRuntime({
    probeHost: async () => { calls.probe++; return healthyProbe; },
    probeTask: async taskId => { calls.task++; return { ok: true, checkpoint: pickCheckpoint(inner) }; },
  });
  const outcome = await runRecovery(runtime, { stateDir, taskId: 'task-42' });
  assert.equal(outcome.status, 'healthy');
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.task.checkpoint, {
    taskId: 'task-42', sessionId: 'session-x', requestId: 'req-y',
    phase: 'submitted', cursor: 17, state: 'running', waitingFor: ['approval'],
  });
  assert.equal('messages' in outcome.task.checkpoint, false);
  assert.equal('cwd' in outcome.task.checkpoint, false);
  assert.equal(calls.task, 1);
  assert.ok(outcome.attempts.some(a => a.kind === 'probe-task' && a.ok));
});

/* 3. stopped -> started -> healthy ---------------------------------------------- */
test('stopped host: exactly one guarded start, recovered=true with observed PID', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  let started = false;
  const { runtime, calls } = fakeRuntime({
    probeHost: async () => {
      calls.probe++;
      return started ? healthyProbe : downProbe;
    },
    inspect: async () => {
      calls.inspect++;
      if (!started) return emptyInspection();
      return { ok: true, listenerPresent: true, listenerPids: [4242], dshPresent: true,
               dshPids: [4242], primaryPid: 4242, primaryStartEpochMs: 111, ownsListener: true, foreignListener: false };
    },
    guardedStart: async () => {
      calls.start++;
      started = true;
      return { ok: true, started: true, detail: 'Started DSH process' };
    },
  });
  const outcome = await runRecovery(runtime, { stateDir });
  assert.equal(outcome.status, 'healthy');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.host.healthy, true);
  assert.equal(outcome.host.recovered, true);
  assert.equal(outcome.host.startedThisCall, true);
  assert.equal(outcome.host.observedPid, 4242);
  assert.equal(calls.start, 1, 'exactly one start invocation');
  const state = readState(stateDir);
  assert.equal(state.lastRecovered, true);
  assert.equal(state.lastObservedHostPid, 4242);
  assert.equal(state.consecutiveHostFailures, 0);
});

/* 4. foreign listener refusal --------------------------------------------------- */
test('foreign 3080 listener: blocked, no start, never replaced', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  const { runtime, calls } = fakeRuntime({
    inspect: async () => {
      calls.inspect++;
      return { ok: true, listenerPresent: true, listenerPids: [9999], dshPresent: false,
               dshPids: [], primaryPid: null, primaryStartEpochMs: null, ownsListener: false, foreignListener: true };
    },
  });
  const outcome = await runRecovery(runtime, { stateDir });
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.host.healthy, false);
  assert.equal(outcome.host.foreignListener, true);
  assert.equal(calls.start, 0, 'foreign listener must not be replaced');
  const state = readState(stateDir);
  assert.equal(state.consecutiveHostFailures, 1);
});

/* 5. live-but-not-ready -> no duplicate start ----------------------------------- */
test('matching process alive but not ready: waits/probes, no duplicate start', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  const { runtime, calls } = fakeRuntime({
    inspect: async () => {
      calls.inspect++;
      return { ok: true, listenerPresent: false, listenerPids: [], dshPresent: true,
               dshPids: [777], primaryPid: 777, primaryStartEpochMs: 5, ownsListener: false, foreignListener: false };
    },
  });
  const outcome = await runRecovery(runtime, { stateDir });
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.exitCode, 1);
  assert.equal(calls.start, 0, 'no duplicate start while process alive');
  assert.ok(calls.probe >= 2, `expected retries, saw ${calls.probe} probes`);
  assert.ok(calls.sleeps.length >= 1, 'backoff waits happened');
  assert.match(outcome.reason, /no duplicate start/);
  assert.equal(outcome.host.observedPid, 777);
  const state = readState(stateDir);
  assert.equal(state.consecutiveHostFailures, 1);
});

/* 6. failed starts -> circuit -> cooldown -> early close by healthy probe ------- */
test('3 failed recoveries open circuit; cooldown starts nothing; healthy read-only probe closes it early', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  const T0 = 1_700_000_000_000;
  let clock = T0;
  let hostUp = false;
  const { runtime, calls } = fakeRuntime({
    now: () => clock,
    probeHost: async () => {
      calls.probe++;
      return hostUp ? healthyProbe : downProbe;
    },
    inspect: async () => { calls.inspect++; return emptyInspection(); },
    guardedStart: async () => { calls.start++; return { ok: true, started: true, detail: 'issued' }; },
  });

  // Calls 1..3: start never produces a healthy host -> failures 1,2,3 -> circuit opens.
  for (let i = 1; i <= 3; i++) {
    const outcome = await runRecovery(runtime, { stateDir });
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.exitCode, 1);
    const state = readState(stateDir);
    assert.equal(state.consecutiveHostFailures, i);
    if (i < 3) {
      assert.equal(state.circuitOpen, false);
    } else {
      assert.equal(state.circuitOpen, true);
      assert.ok(state.circuitOpenUntilMs === T0 + 5 * 60 * 1000);
    }
  }
  assert.equal(calls.start, 3, 'one start per recovery call');

  // Call 4: inside cooldown -> no start, no task probing, cooldown exit code 3.
  const callsBefore = { ...calls };
  const outcome4 = await runRecovery(runtime, { stateDir, taskId: 'x' });
  assert.equal(outcome4.status, 'cooldown');
  assert.equal(outcome4.exitCode, 3);
  assert.equal(calls.start, callsBefore.start);
  assert.equal(calls.task, 0, 'no task inspection while host down in cooldown');
  const state4 = readState(stateDir);
  assert.equal(state4.circuitOpen, true);
  assert.equal(state4.consecutiveHostFailures, 3);

  // Call 5: host healthy again while the circuit is still open -> read-only probe closes it early.
  hostUp = true;
  const outcome5 = await runRecovery(runtime, { stateDir });
  assert.equal(outcome5.status, 'healthy');
  assert.equal(outcome5.exitCode, 0);
  assert.equal(outcome5.host.healthy, true);
  assert.equal(outcome5.host.recovered, false);
  assert.equal(calls.start, 3, 'no start issued after healthy probe');
  const state5 = readState(stateDir);
  assert.equal(state5.circuitOpen, false);
  assert.equal(state5.consecutiveHostFailures, 0);
  assert.equal(state5.lastHostHealthy, true);
});

/* 7. task status failure does not affect host health/circuit -------------------- */
test('task status failure: exit 4, host stays healthy, no circuit change, no start', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  const { runtime, calls } = fakeRuntime({
    probeHost: async () => { calls.probe++; return healthyProbe; },
    probeTask: async () => { calls.task++; return { ok: false, reason: 'ENOENT: task record missing for id ghost' }; },
  });
  const outcome = await runRecovery(runtime, { stateDir, taskId: 'ghost' });
  assert.equal(outcome.status, 'task-inspection-failed');
  assert.equal(outcome.exitCode, 4);
  assert.equal(outcome.host.healthy, true, 'host health is separate from task failures');
  assert.equal(calls.start, 0);
  const state = readState(stateDir);
  assert.equal(state.consecutiveHostFailures, 0, 'task failures never advance the host circuit');
  assert.equal(state.circuitOpen, false);
  assert.equal(state.lastTaskInspectionOk, false);
  assert.equal(state.lastStatus, 'task-inspection-failed');

  // A follow-up call without a task id is a normal healthy call.
  const outcome2 = await runRecovery(runtime, { stateDir });
  assert.equal(outcome2.status, 'healthy');
  assert.equal(outcome2.exitCode, 0);
});

/* 8. recovery lock held by a live process -> busy ------------------------------- */
test('busy when another live recovery holds the lock; nothing probed or started', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  writeLockFile(stateDir, { pid: process.pid, host: os.hostname(), nonce: 'held', at: new Date().toISOString() });
  const { runtime, calls } = fakeRuntime({ isAlive: async () => true });
  const outcome = await runRecovery(runtime, { stateDir, lockWaitMs: 60, lockPollMs: 10 });
  assert.equal(outcome.status, 'busy');
  assert.equal(outcome.exitCode, 2);
  assert.equal(calls.probe, 0);
  assert.equal(calls.start, 0);
  assert.ok(existsSync(lockPathFor(stateDir)), 'live holder lock is never removed');
});

/* 9. stale lock (holder dead, same host) is recovered --------------------------- */
test('stale lock on our host (holder proven dead) is recovered and the call proceeds', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  writeLockFile(stateDir, { pid: 2 ** 30, host: os.hostname(), nonce: 'stale', at: new Date().toISOString() });
  const { runtime, calls } = fakeRuntime({
    isAlive: async () => false,
    probeHost: async () => { calls.probe++; return healthyProbe; },
  });
  const outcome = await runRecovery(runtime, { stateDir });
  assert.equal(outcome.status, 'healthy');
  assert.equal(outcome.exitCode, 0);
  assert.equal(calls.probe, 1);
  assert.ok(!existsSync(lockPathFor(stateDir)), 'stale lock removed after recovery');
});

/* 10. stale lock on another host is not stolen ---------------------------------- */
test('lock owned by another host is never stolen: busy result, file untouched', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  writeLockFile(stateDir, { pid: 2 ** 30, host: 'SOME-OTHER-MACHINE', nonce: 'foreign', at: new Date().toISOString() });
  const { runtime, calls } = fakeRuntime({ isAlive: async () => false });
  const outcome = await runRecovery(runtime, { stateDir, lockWaitMs: 60, lockPollMs: 10 });
  assert.equal(outcome.status, 'busy');
  assert.equal(outcome.exitCode, 2);
  assert.equal(calls.probe, 0);
  assert.ok(existsSync(lockPathFor(stateDir)), 'foreign lock file remains');
});

/* 11. lock release only when nonce matches -------------------------------------- */
test('releaseRecoveryLock removes only the lock whose nonce matches', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  const lockPath = lockPathFor(stateDir);
  writeLockFile(stateDir, { pid: 1, host: os.hostname(), nonce: 'abc', at: new Date().toISOString() });
  await releaseRecoveryLock(lockPath, 'different');
  assert.ok(existsSync(lockPath), 'nonce mismatch leaves the lock alone');
  await releaseRecoveryLock(lockPath, 'abc');
  assert.ok(!existsSync(lockPath), 'matching nonce releases the lock');
});

/* 12. redaction ----------------------------------------------------------------- */
test('redact strips token-like values and truncates', () => {
  const out = redact('auth failed for http://127.0.0.1:3080/?token=secret12345 and Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.ok(!out.includes('secret12345'));
  assert.ok(!out.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  assert.ok(!/token=/.test(out) || !out.includes('secret'));
  const long = redact('x'.repeat(500));
  assert.ok(long.length <= 245);
});

/* 13. CLI parsing --------------------------------------------------------------- */
test('CLI parsing: defaults, overrides, usage errors', () => {
  const def = parseCliArgs([]);
  assert.equal(def.ok, true);
  assert.equal(def.stateDir, DEFAULTS.stateDir);
  assert.equal(def.taskId, null);

  const over = parseCliArgs(['--task-id', 'alpha_1', '--state-dir', join(os.tmpdir(),'rec')]);
  assert.equal(over.ok, true);
  assert.equal(over.taskId, 'alpha_1');
  assert.equal(over.stateDir, join(os.tmpdir(),'rec'));

  const overEq = parseCliArgs(['--task-id=beta-2', '--state-dir='+join(os.tmpdir(),'rec2')]);
  assert.equal(overEq.ok, true);
  assert.equal(overEq.taskId, 'beta-2');

  assert.equal(parseCliArgs(['--task-id']).ok, false);
  assert.equal(parseCliArgs(['--task-id', 'bad id!']).ok, false);
  assert.equal(parseCliArgs(['--state-dir', 'relative/dir']).ok, false);
  assert.equal(parseCliArgs(['--bogus']).ok, false);
  const help = parseCliArgs(['--help']);
  assert.equal(help.ok, false);
  assert.equal(help.exitCode, 0);
});

/* 14. probe / checkpoint parsing units ------------------------------------------ */
test('classifyHostProbe parses invoke.mjs output shapes', () => {
  const healthyStdout = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ connected: true, dshVersion: 'x' }) }] });
  assert.equal(classifyHostProbe({ code: 0, stdout: healthyStdout, timedOut: false }).ok, true);
  const errorStdout = JSON.stringify({ isError: true, content: [{ type: 'text', text: 'DSH has not announced readiness.' }] });
  const err = classifyHostProbe({ code: 1, stdout: errorStdout, timedOut: false });
  assert.equal(err.ok, false);
  assert.match(err.reason, /readiness/);
  assert.equal(classifyHostProbe({ code: null, stdout: '', timedOut: true }).ok, false);
  const noisy = classifyHostProbe({ code: 0, stdout: `junk\n${healthyStdout}\njunk`, timedOut: false });
  assert.equal(noisy.ok, true);
});

test('pickCheckpoint only copies the agreed keys', () => {
  const cp = pickCheckpoint({
    taskId: 't', sessionId: 's', requestId: 'r', phase: 'p', cursor: 3,
    state: 'running', waitingFor: [], secret: 'no', messages: [{ text: 'x' }],
  });
  assert.deepEqual(cp, { taskId: 't', sessionId: 's', requestId: 'r', phase: 'p', cursor: 3, state: 'running', waitingFor: [] });
});

/* 15. task requested while cooldown --------------------------------------------- */
test('cooldown: task inspection is skipped, host never restarted or started', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  // Seed an open circuit with a far-future openUntil.
  writeFileSync(join(stateDir, DEFAULTS.stateFile), JSON.stringify({
    schemaVersion: 1, consecutiveHostFailures: 3, circuitOpen: true,
    circuitOpenUntilMs: Date.now() + 5 * 60 * 1000,
  }));
  const { runtime, calls } = fakeRuntime({});
  const outcome = await runRecovery(runtime, { stateDir, taskId: 'task-9' });
  assert.equal(outcome.status, 'cooldown');
  assert.equal(outcome.exitCode, 3);
  assert.equal(calls.start, 0);
  assert.equal(calls.task, 0);
  assert.equal(calls.probe, 1, 'exactly one read-only probe during cooldown');
});

/* 16. normalizeInspection fails closed on exit code / timedOut / shape -------- */
test('normalizeInspection: honors exit code, timedOut and rejects incomplete payloads like {}', () => {
  const complete = {
    ok: true, listener: { present: true, pids: [17904] },
    dsh: { present: true, pids: [17904], primaryPid: 17904, primaryStartEpochMs: 42,
           anyExactEntry: true, anyHostArgs: true },
    ownsListener: true, foreignListener: false,
  };
  const ok = normalizeInspection({ code: 0, stdout: JSON.stringify(complete), timedOut: false });
  assert.equal(ok.ok, true);
  assert.equal(ok.listenerPresent, true);
  assert.equal(ok.primaryPid, 17904);
  assert.equal(ok.foreignListener, false);

  // {} must NOT be treated as "no listener / no process".
  const empty = normalizeInspection({ code: 0, stdout: '{}' });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /incomplete/);

  // ok:true but missing listener/dsh sections -> rejected, never absence.
  const partial = normalizeInspection({ code: 0, stdout: JSON.stringify({ ok: true, listener: { present: false, pids: [] } }) });
  assert.equal(partial.ok, false);
  assert.match(partial.reason, /incomplete/);

  // Nonzero exit with no payload -> rejected mentioning the code.
  const exit2 = normalizeInspection({ code: 2, stdout: '', timedOut: false });
  assert.equal(exit2.ok, false);
  assert.match(exit2.reason, /exit 2/);

  // ok:true payload but nonzero exit -> exit code wins.
  const exit1Ok = normalizeInspection({ code: 1, stdout: JSON.stringify(complete) });
  assert.equal(exit1Ok.ok, false);
  assert.match(exit1Ok.reason, /exited 1/);

  // Explicit ok:false from the script -> surfaced, sanitized.
  const denied = normalizeInspection({ code: 1, stdout: JSON.stringify({ ok: false, error: 'listener enumeration unavailable: denied' }) });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /denied/);

  // Timeout -> rejected as timed out, never absent.
  const timedOut = normalizeInspection({ code: null, stdout: '', timedOut: true });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.reason, /timed out/);
});

test('classifyHostProbe honors spawn error and incomplete outer shapes', () => {
  const err = classifyHostProbe({ code: null, stdout: '', timedOut: false, error: new Error('EPERM') });
  assert.equal(err.ok, false);
  assert.match(err.reason, /could not be started/);
  const incomplete = classifyHostProbe({ code: 0, stdout: '{}' });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reason, /incomplete/);
  const exit3 = classifyHostProbe({ code: 3, stdout: '' });
  assert.equal(exit3.ok, false);
  assert.match(exit3.reason, /exited 3/);
});

/* 17. corrupt persisted state -> internal error, preserved, never auto-reset -- */
test('corrupt recovery state: internal error, file preserved, no probe and no circuit reset', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  const stateFile = join(stateDir, DEFAULTS.stateFile);
  const garbage = '{ this is not json, circuitOpen: true';
  writeFileSync(stateFile, garbage, 'utf8');
  const { runtime, calls } = fakeRuntime({
    probeHost: async () => { calls.probe++; return healthyProbe; },
  });
  const outcome = await runRecovery(runtime, { stateDir });
  assert.equal(outcome.status, 'internal-error');
  assert.equal(outcome.exitCode, 6);
  assert.equal(calls.probe, 0, 'no probe runs against corrupt accounting');
  assert.equal(readFileSync(stateFile, 'utf8'), garbage, 'corrupt file preserved byte-for-byte');
  assert.ok(!existsSync(lockPathFor(stateDir)), 'lock released');
});

/* 18. task checkpoint/taskId persistence (issue 4) ------------------------------ */
test('task checkpoint persisted on success; preserved across later failures; circuit untouched', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  const probeHealthy = async () => healthyProbe;
  const checkpointA = {
    taskId: 'long-task', sessionId: 'sess-1', requestId: 'req-1', phase: 'submitted',
    cursor: 7, state: 'running', waitingFor: ['approval'],
  };

  // Call 1: healthy + successful inspection persists the checkpoint.
  const runtime1 = fakeRuntime({
    probeHost: probeHealthy,
    probeTask: async taskId => ({ ok: true, checkpoint: pickCheckpoint(checkpointA) }),
  }).runtime;
  const outcome1 = await runRecovery(runtime1, { stateDir, taskId: 'long-task' });
  assert.equal(outcome1.exitCode, 0);
  let state = readState(stateDir);
  assert.equal(state.lastTaskId, 'long-task');
  assert.equal(state.lastTaskInspectionOk, true);
  assert.deepEqual(state.lastTaskCheckpoint, checkpointA);
  assert.equal(state.taskFailureReason, null);
  assert.ok(state.taskInspectionAt);

  // Call 2: inspection now fails -> previous checkpoint preserved, failure
  // recorded, and the Host circuit/counters stay untouched.
  const runtime2 = fakeRuntime({
    probeHost: probeHealthy,
    probeTask: async () => ({ ok: false, reason: 'ENOENT: task record missing' }),
  }).runtime;
  const outcome2 = await runRecovery(runtime2, { stateDir, taskId: 'long-task' });
  assert.equal(outcome2.status, 'task-inspection-failed');
  assert.equal(outcome2.exitCode, 4);
  state = readState(stateDir);
  assert.equal(state.lastTaskId, 'long-task');
  assert.equal(state.lastTaskInspectionOk, false);
  assert.deepEqual(state.lastTaskCheckpoint, checkpointA, 'previous successful checkpoint preserved');
  assert.match(state.taskFailureReason, /missing/);
  assert.equal(state.consecutiveHostFailures, 0, 'task failure never advances the host circuit');
  assert.equal(state.circuitOpen, false);

  // Call 3: no task requested -> persisted task evidence unchanged.
  const runtime3 = fakeRuntime({ probeHost: probeHealthy }).runtime;
  const outcome3 = await runRecovery(runtime3, { stateDir });
  assert.equal(outcome3.exitCode, 0);
  state = readState(stateDir);
  assert.equal(state.lastTaskId, 'long-task');
  assert.equal(state.lastTaskInspectionOk, false);
  assert.deepEqual(state.lastTaskCheckpoint, checkpointA);
});

/* 19. serialized stale-lock reclamation (issue: TOCTOU) ------------------------ */
test('stale-lock reclamation is serialized: live reclaim token defers deletion; free token lets recovery proceed', async () => {
  const stateDir = makeStateDir();
  tmpDirs.push(stateDir);
  const lockPath = lockPathFor(stateDir);
  const reclaimPath = `${lockPath}.reclaim`;
  const stalePid = 2 ** 30;
  // Stale recovery.lock (dead holder, our host) + .reclaim held by a LIVE process.
  writeLockFile(stateDir, { pid: stalePid, host: os.hostname(), nonce: 'stale', at: new Date().toISOString() });
  writeFileSync(reclaimPath, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'held-reclaim', at: new Date().toISOString() }), 'utf8');
  const isAlive = async pid => pid !== stalePid; // only the stale lock holder is dead
  const { runtime, calls } = fakeRuntime({
    isAlive,
    probeHost: async () => { calls.probe++; return healthyProbe; },
  });
  const outcome = await runRecovery(runtime, { stateDir, lockWaitMs: 150, lockPollMs: 20 });
  assert.equal(outcome.status, 'busy', 'reclamation deferred while the critical section is held');
  assert.equal(calls.probe, 0);
  assert.ok(existsSync(lockPath), 'stale lock untouched while reclaim token is held');
  assert.ok(existsSync(reclaimPath), 'reclaim token untouched');

  // Release the reclaim token: the next call enters the section, proves the
  // holder dead, re-checks on-disk identity, reclaims, and proceeds healthy.
  await releaseRecoveryLock(reclaimPath, 'held-reclaim');
  const outcome2 = await runRecovery(runtime, { stateDir });
  assert.equal(outcome2.status, 'healthy');
  assert.equal(outcome2.exitCode, 0);
  assert.ok(!existsSync(lockPath), 'stale lock reclaimed and lock released');
  assert.ok(!existsSync(reclaimPath), 'reclaim token released');
});

test('an orphan reclamation token is preserved instead of recursively recreating the deletion race', async () => {
  const stateDir = makeStateDir(); tmpDirs.push(stateDir);
  const reclaimPath = `${lockPathFor(stateDir)}.reclaim`;
  writeLockFile(stateDir, { pid: 2 ** 30, host: os.hostname(), nonce: 'stale-main' });
  const token = JSON.stringify({ pid: 2 ** 30, host: os.hostname(), nonce: 'stale-reclaim' });
  writeFileSync(reclaimPath, token);
  const { runtime, calls } = fakeRuntime({ isAlive: async () => false });
  const result = await runRecovery(runtime, { stateDir, lockWaitMs: 100, lockPollMs: 20 });
  assert.equal(result.status, 'busy');
  assert.equal(readFileSync(reclaimPath, 'utf8'), token);
  assert.equal(calls.probe, 0);
});
