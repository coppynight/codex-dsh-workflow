#!/usr/bin/env node
/**
 * dsh-recover.mjs - bounded, on-demand recovery helper for the Codex+DSH+Claude
 * long-running workflow (DSH host on http://127.0.0.1:3080).
 *
 * Responsibilities (see coordination contract):
 *   - Authenticated host health is always checked through a FRESH node
 *     subprocess that runs the EXISTING bridge invoke.mjs dsh_host_status.
 *     This helper never talks to DSH itself and never prints credential or
 *     log contents.  Task inspection (--task-id) goes through
 *     `invoke.mjs dsh_status <tmp.json>` with a temporary JSON input file and
 *     only exposes task/session/request/cursor/phase/state/waitingFor.
 *   - When the host is not reachable, host-process.ps1 (read-only) reports the
 *     3080 listener plus the exact configured DSH node.exe process.  Output
 *     only ever contains PIDs / start times / owned-identity booleans.
 *   - Never kills processes.  A foreign 3080 listener is reported BLOCKED and
 *     is never replaced.
 *   - Start (only when nothing is listening AND no matching DSH process) runs
 *     the configured start-host helper hidden through host-process.ps1 -StartGuard,
 *     serialized by a Windows named mutex with an in-mutex recheck.  At most
 *     one start invocation per recovery call.  Inspection FAILS CLOSED: any
 *     process/listener enumeration error or incomplete payload is treated as
 *     "cannot classify" and never as absence, so no blind duplicate start.
 *   - Bounded retries with backoff 2s/5s/10s; each probe subprocess capped at
 *     35s.  Persistent circuit: after 3 consecutive failed recovery calls a
 *     5-minute cooldown opens; a healthy READ-ONLY probe closes it early.
 *   - Complete recovery calls are serialized across processes by an atomic
 *     lock file carrying PID metadata.  Stale locks are reclaimed inside a
 *     serialized reclamation critical section (a second exclusive token file)
 *     only after the recorded process is proven dead and the on-disk lock is
 *     re-checked while holding the section.  State is saved atomically
 *     (write tmp + rename).  Bridge task/workspace locks and claims are NEVER
 *     touched.
 *   - Failure during recovery never triggers mutation replay, and host-health
 *     accounting is strictly separate from task-status failures (a missing
 *     taskId / history error must not cause host restarts or circuit churn).
 *   - The last requested taskId and the last SUCCESSFUL task checkpoint are
 *     persisted in recovery-state.json so long-task evidence survives across
 *     calls; a failed inspection keeps the previous successful checkpoint.
 *   - Corrupt/unreadable persisted state is an internal error: it is reported,
 *     never silently reset (a corrupted cooldown is never auto-cleared) and
 *     the file is preserved for inspection.
 *
 * CLI:  node dsh-recover.mjs [--task-id ID] [--state-dir ABS_DIR]
 * Default state dir: the configured bridge state/recovery directory
 *
 * Exit codes:
 *   0 healthy (and, when --task-id was given, the task was inspected)
 *   1 unavailable       2 blocked/busy       3 cooldown
 *   4 task-inspection-failed                 5 usage   6 internal-error
 *
 * Output: a single concise JSON document on stdout.
 *
 * This module is dependency-injectable: runRecovery(runtime, opts) drives the
 * whole flow against a runtime object (probeHost/inspect/guardedStart/
 * probeTask/sleep/now/isAlive), so tests can use fakes with no subprocesses.
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { accessSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { loadConfig, isMain as isMainModule } from './config.mjs';

export const VERSION = '1.1.0';

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = Object.freeze({
  stateDir: join(os.homedir(), '.codex-dsh-workflow', 'bridge-state', 'recovery'),
  stateFile: 'recovery-state.json',
  lockFile: 'recovery.lock',
  invokePath: join(here, '..', 'bridge', 'invoke.mjs'),
  hostProcessPs: join(here, 'host-process.ps1'),
  startScript: join(here, 'start-host.ps1'),
  hostEntry: '',
  nodeExe: process.execPath,
  port: 3080,
  hostAddr: '127.0.0.1',
  probeTimeoutMs: 35000,   // cap per probe subprocess
  processTimeoutMs: 35000, // cap per powershell inspection subprocess
  startTimeoutMs: 35000,   // cap per guarded-start subprocess
  mutexWaitMs: 15000,      // inside host-process.ps1 -StartGuard
  retryWaitMs: [2000, 5000, 10000], // backoff between probes
  lockWaitMs: 10000,       // how long to wait for a busy recovery lock
  lockPollMs: 150,
  reclaimWaitMs: 2000,     // cap for the stale-lock reclamation section
  cooldownMs: 5 * 60 * 1000, // 5-minute persistent cooldown
  circuitThreshold: 3,       // consecutive failed recovery calls open the circuit
  keepAttempts: 12,          // attempts retained in persisted state
});

/* ------------------------------------------------------------------ *
 * sanitize / parse helpers
 * ------------------------------------------------------------------ */

/** Redact secret-looking material so failure reasons never carry credentials. */
export function redact(value) {
  let s = String(value ?? '');
  s = s.replace(/(authorization|bearer|cookie)\s*[:=]\s*[^\s,"']+/gi, '$1=[redacted]');
  s = s.replace(/(\?|&)token=[^&\s"']+/gi, '$1token=[redacted]');
  s = s.replace(/https?:\/\/[^\s"']*\?token=[^\s"']*/gi, '[url-token-redacted]');
  s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted]');
  s = s.replace(/\b[A-Za-z0-9_\-./+]{64,}\b/g, '[redacted]');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 240) s = `${s.slice(0, 240)}...[truncated]`;
  return s;
}

/** Parse text that should be JSON, tolerating surrounding noise. Syntax only:
 *  shape validation is the caller's job (see normalizeInspection etc.). */
export function parseLooseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { return null; }
  }
  return null;
}

function contentText(result) {
  try {
    const blocks = Array.isArray(result?.content) ? result.content : [];
    for (const block of blocks) if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
  } catch { /* ignore */ }
  return '';
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Classify the output of `node invoke.mjs dsh_host_status`. Honors subprocess
 *  exit code / timedOut / spawn error and rejects incomplete payloads. */
export function classifyHostProbe({ code, stdout, timedOut, error } = {}) {
  if (timedOut) return { ok: false, reason: 'host status probe timed out' };
  if (error) return { ok: false, reason: 'host status probe could not be started' };
  if (code !== 0 && code !== 1) return { ok: false, reason: `host status probe exited ${code}` };
  const outer = parseLooseJson(stdout);
  if (!outer) return { ok: false, reason: `host status probe returned no parseable JSON (exit ${code})` };
  if (!isPlainObject(outer) || !Array.isArray(outer.content)) {
    return { ok: false, reason: 'host status probe returned an incomplete payload' };
  }
  if (outer.isError === true) {
    return { ok: false, reason: redact(contentText(outer) || 'host status error') };
  }
  const text = contentText(outer);
  if (!text) return { ok: false, reason: 'host status probe returned an empty payload' };
  const inner = parseLooseJson(text);
  if (!inner || inner.connected !== true) {
    return { ok: false, reason: 'host status did not report connected' };
  }
  return { ok: true, inner };
}

const CHECKPOINT_KEYS = ['taskId', 'sessionId', 'requestId', 'phase', 'cursor', 'state', 'waitingFor'];

/** Copy only the agreed task checkpoint fields; never evidence/message content. */
export function pickCheckpoint(inner) {
  const checkpoint = {};
  if (inner && typeof inner === 'object') {
    for (const key of CHECKPOINT_KEYS) {
      if (inner[key] !== undefined && inner[key] !== null) checkpoint[key] = inner[key];
    }
  }
  return checkpoint;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function usageError(error) {
  return { ok: false, exitCode: 5, error };
}

/** node dsh-recover.mjs [--task-id ID] [--state-dir ABS_DIR] */
export function parseCliArgs(argv) {
  let taskId;
  let stateDir;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--task-id') {
      if (i + 1 >= argv.length) return usageError('--task-id requires a value');
      taskId = argv[++i];
    } else if (arg.startsWith('--task-id=')) {
      taskId = arg.slice('--task-id='.length);
    } else if (arg === '--state-dir') {
      if (i + 1 >= argv.length) return usageError('--state-dir requires a value');
      stateDir = argv[++i];
    } else if (arg.startsWith('--state-dir=')) {
      stateDir = arg.slice('--state-dir='.length);
    } else if (arg === '--help' || arg === '-h') {
      return {
        ok: false, exitCode: 0, help: true,
        error: 'usage: node dsh-recover.mjs [--task-id ID] [--state-dir ABS_DIR]',
      };
    } else {
      return usageError(`unknown argument: ${arg}`);
    }
  }
  if (taskId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) {
    return usageError('--task-id must match [A-Za-z0-9_-]{1,100}');
  }
  if (stateDir === undefined) stateDir = process.env.DSH_RECOVER_STATE_DIR || DEFAULTS.stateDir;
  if (!isAbsolute(stateDir)) return usageError('--state-dir must be an absolute path');
  return { ok: true, taskId: taskId ?? null, stateDir };
}

/* ------------------------------------------------------------------ *
 * persisted state (atomic writes; corrupt state is never auto-reset)
 * ------------------------------------------------------------------ */

function stateError(error, message) {
  const wrapped = new Error(`${message} (${error && error.code ? error.code : 'error'})`);
  wrapped.code = error && error.code && error.code !== 'STATE_CORRUPT' && error.code !== 'STATE_UNREADABLE'
    ? error.code : 'STATE_CORRUPT';
  return wrapped;
}

async function readStateFile(opts) {
  const path = join(opts.stateDir, opts.stateFile);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw stateError(error, 'recovery state is unreadable; preserving it');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw stateError(error, 'recovery state is corrupt (invalid JSON); preserving it');
  }
  if (!isPlainObject(parsed)) {
    throw stateError(new Error('not an object'), 'recovery state is corrupt; preserving it');
  }
  const invalidAccounting =
    (parsed.schemaVersion !== undefined && ![1,2].includes(parsed.schemaVersion)) ||
    (parsed.circuitOpen !== undefined && typeof parsed.circuitOpen !== 'boolean') ||
    (parsed.consecutiveHostFailures !== undefined && (!Number.isSafeInteger(parsed.consecutiveHostFailures) || parsed.consecutiveHostFailures < 0)) ||
    (parsed.circuitOpenUntilMs != null && (!Number.isFinite(parsed.circuitOpenUntilMs) || Math.abs(parsed.circuitOpenUntilMs) > 8.64e15)) ||
    (parsed.circuitOpen === true && !Number.isFinite(parsed.circuitOpenUntilMs)) ||
    (parsed.attempts !== undefined && !Array.isArray(parsed.attempts));
  if (invalidAccounting) throw stateError(new Error('invalid accounting schema'), 'recovery state is corrupt; preserving it before any service action');
  return parsed;
}

async function writeStateFileAtomically(opts, state) {
  await mkdir(opts.stateDir, { recursive: true });
  const path = join(opts.stateDir, opts.stateFile);
  const tmp = join(opts.stateDir, `${opts.stateFile}.tmp-${process.pid}-${randomUUID()}`);
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(JSON.stringify(state, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

/* ------------------------------------------------------------------ *
 * exclusive file locks (PID metadata) + serialized stale reclamation
 * ------------------------------------------------------------------ */

async function tryWriteLockFile(path, holder, nonce, runtime) {
  try {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(JSON.stringify({
        pid: holder.pid, host: holder.host, nonce,
        at: new Date(runtime.now()).toISOString(),
      }), 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    return false;
  }
}

async function readLockJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch { return null; }
}

function sameHolderHost(lock, host) {
  return lock.host === undefined || lock.host === null || lock.host === host;
}

/**
 * Serialized reclamation critical section: only one process may delete a
 * stale recovery lock at a time.  Reclaimers contend on `<lock>.reclaim`;
 * fresh acquirers never unlink anything, so holding the section makes the
 * read-check-unlink of the actual lock atomic with respect to every writer.
 */
async function acquireReclaimToken(lockPath, holder, runtime, opts, outerDeadline) {
  const path = `${lockPath}.reclaim`;
  const nonce = randomUUID();
  const deadline = Math.min(outerDeadline, runtime.now() + opts.reclaimWaitMs);
  for (;;) {
    if (await tryWriteLockFile(path, holder, nonce, runtime)) return { acquired: true, path, nonce };
    // Do not recursively reclaim this serialization token: doing so recreates
    // the check/unlink race one level down. A stranded token needs scoped
    // coordinator cleanup after no recovery process can still use it.
    if (runtime.now() >= deadline) return { acquired: false, path, nonce: null };
    await runtime.sleep(opts.lockPollMs);
  }
}

export async function acquireRecoveryLock(opts, runtime) {
  const lockPath = join(opts.stateDir, opts.lockFile);
  const deadline = runtime.now() + opts.lockWaitMs;
  const holder = { pid: opts.pid ?? process.pid, host: opts.host ?? os.hostname() };
  const nonce = randomUUID();
  for (;;) {
    if (await tryWriteLockFile(lockPath, holder, nonce, runtime)) {
      return { acquired: true, lockPath, nonce };
    }
    // Lock exists: stale only if its holder is proven dead AND it is on our host.
    const existing = await readLockJson(lockPath);
    if (existing && Number.isInteger(existing.pid) && existing.pid > 0 &&
        typeof existing.nonce === 'string' && sameHolderHost(existing, holder.host)) {
      let alive = true;
      try { alive = await runtime.isAlive(existing.pid); } catch { alive = true; }
      if (!alive) {
        const reclaim = await acquireReclaimToken(lockPath, holder, runtime, opts, deadline);
        if (reclaim.acquired) {
          try {
            // Inside the serialized section: only delete if the on-disk lock is
            // STILL this proven-dead holder (never a replacement).
            const current = await readLockJson(lockPath);
            let stillStale = false;
            if (current && current.pid === existing.pid && current.nonce === existing.nonce) {
              let aliveNow = true;
              try { aliveNow = await runtime.isAlive(current.pid); } catch { aliveNow = true; }
              stillStale = !aliveNow;
            }
            if (stillStale) {
              try { await unlink(lockPath); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
            }
          } finally {
            await releaseRecoveryLock(reclaim.path, reclaim.nonce);
          }
          continue; // retry fresh acquisition immediately
        }
        // Another reclaimer holds the section; fall through to bounded wait.
      }
    }
    if (runtime.now() >= deadline) {
      return { acquired: false, lockPath, reason: 'busy', nonce: null };
    }
    await runtime.sleep(opts.lockPollMs);
  }
}

export async function releaseRecoveryLock(lockPath, nonce) {
  if (!lockPath || !nonce) return;
  try {
    const current = JSON.parse(await readFile(lockPath, 'utf8'));
    if (current && current.nonce === nonce) await unlink(lockPath);
  } catch { /* already gone or not ours */ }
}

/* ------------------------------------------------------------------ *
 * recovery orchestration
 * ------------------------------------------------------------------ */

function attemptEntry(runtime, kind, ok, detail) {
  const entry = { at: new Date(runtime.now()).toISOString(), kind, ok: !!ok };
  if (detail) entry.detail = String(detail).slice(0, 240);
  return entry;
}

const emptyHost = () => ({
  healthy: null, recovered: false, startedThisCall: false,
  observedPid: null, foreignListener: null,
});

const emptyCircuit = state => ({
  open: !!state.circuitOpen,
  openUntil: state.circuitOpenUntilMs ? new Date(state.circuitOpenUntilMs).toISOString() : null,
  consecutiveFailures: state.consecutiveHostFailures || 0,
});

function internalErrorOutcome(reason) {
  return {
    status: 'internal-error', exitCode: 6,
    host: emptyHost(),
    circuit: { open: false, openUntil: null, consecutiveFailures: 0 },
    attempts: [], reason, task: null,
  };
}

/**
 * Run one bounded recovery call. `runtime` must provide:
 *   now(), sleep(ms), isAlive(pid),
 *   probeHost(), inspect(), guardedStart(), probeTask(taskId)
 * and `opts` at least { stateDir, taskId? } (defaults merged below).
 * Returns an outcome object {status, exitCode, host, circuit, attempts, ...}
 * and persists machine-readable state atomically.
 */
export async function runRecovery(runtime, optsIn = {}) {
  const opts = { ...DEFAULTS, ...optsIn };
  const outcome = {
    status: 'unavailable', exitCode: 1, host: emptyHost(),
    circuit: emptyCircuit({}), attempts: [], reason: null, task: null,
  };
  await mkdir(opts.stateDir, { recursive: true });

  const lock = await acquireRecoveryLock(opts, runtime);
  if (!lock.acquired) {
    let state = {};
    try { state = await readStateFile(opts); } catch { state = {}; } // busy echo only; nothing written
    outcome.status = 'busy';
    outcome.exitCode = 2;
    outcome.reason = 'another recovery call holds the recovery lock';
    outcome.circuit = emptyCircuit(state);
    outcome.host.healthy = null;
    return outcome;
  }

  try {
    let state;
    try {
      state = await readStateFile(opts);
    } catch (error) {
      // Corrupt/unreadable state: report internal error and PRESERVE the file.
      // Never auto-reset a cooldown or start fresh from corrupted accounting.
      outcome.status = 'internal-error';
      outcome.exitCode = 6;
      outcome.reason = redact(error && error.message ? error.message : String(error));
      return outcome;
    }
    const attempts = [];
    const now = () => runtime.now();
    const record = (kind, ok, detail) => attempts.push(attemptEntry(runtime, kind, ok, detail));

    const cooldownActive =
      !!state.circuitOpen && Number.isFinite(state.circuitOpenUntilMs) &&
      state.circuitOpenUntilMs > now();

    /* ---- cooldown pass: read-only probe may close the circuit early ----- */
    if (cooldownActive) {
      const probe = await runtime.probeHost();
      record('probe-host', probe.ok, probe.ok ? undefined : probe.reason);
      let insp = null;
      if (!probe.ok) {
        try {
          insp = await runtime.inspect();
          record('inspect', !!insp && insp.ok !== false,
            insp && insp.ok === false ? (insp.reason || 'process inspection failed') : undefined);
        } catch {
          record('inspect', false, 'process inspection failed');
        }
      }
      if (probe.ok) {
        // Healthy read-only probe closes the circuit early.
        state.consecutiveHostFailures = 0;
        state.circuitOpen = false;
        state.circuitOpenUntilMs = null;
        outcome.host.healthy = true;
        outcome.host.foreignListener = false;
        const taskInfo = opts.taskId ? await inspectTask(runtime, opts.taskId, record) : { ok: true, checkpoint: null };
        outcome.task = taskInfo.ok ? { ok: true, checkpoint: taskInfo.checkpoint } : { ok: false, reason: taskInfo.reason };
        outcome.status = taskInfo.ok ? 'healthy' : 'task-inspection-failed';
        outcome.exitCode = taskInfo.ok ? 0 : 4;
        if (!taskInfo.ok) outcome.reason = `task inspection failed (host healthy): ${taskInfo.reason}`;
        outcome.host.recovered = false;
      } else {
        // Cooldown stays; never start during cooldown.
        outcome.status = 'cooldown';
        outcome.exitCode = 3;
        outcome.reason = 'circuit open (cooldown) and read-only probe did not find a healthy host';
        outcome.host.healthy = false;
        outcome.host.observedPid = insp ? (insp.primaryPid ?? insp.dsh?.primaryPid ?? null) : null;
        outcome.host.foreignListener = insp ? (insp.foreignListener ?? null) : null;
        outcome.circuit = emptyCircuit(state);
      }
      outcome.attempts = attempts;
      outcome.circuit = emptyCircuit(state);
      await persistState(opts, state, outcome, attempts);
      return outcome;
    }

    /* ---- normal pass ---------------------------------------------------- */
    let startAttempted = false; // at most one guarded-start invocation per call
    let startIssued = false;    // the guarded start actually launched a host
    let foreignSeen = false;
    let healthy = false;
    let lastInsp = null;
    let inspectionEverOk = false;

    for (let retryIdx = 0; ; retryIdx++) {
      const probe = await runtime.probeHost();
      record('probe-host', probe.ok, probe.ok ? undefined : probe.reason);
      if (probe.ok) { healthy = true; break; }

      let insp = null;
      try {
        insp = await runtime.inspect();
        record('inspect', !!insp && insp.ok !== false,
          insp && insp.ok === false ? (insp.reason || 'process inspection failed') : undefined);
      } catch {
        record('inspect', false, 'process inspection failed');
      }
      if (insp && insp.ok !== false) {
        inspectionEverOk = true;
        lastInsp = insp;
        if (insp.foreignListener) { foreignSeen = true; break; }
      }
      const inspectUsable = insp && insp.ok !== false;
      if (!startAttempted && !foreignSeen && inspectUsable &&
          !insp.listenerPresent && !insp.dshPresent) {
        startAttempted = true;
        try {
          const startResult = await runtime.guardedStart();
          const ok = !!startResult && startResult.ok === true;
          record('start-guarded', ok,
            ok ? (startResult.detail || (startResult.started ? 'start issued' : 'start not issued'))
               : (startResult?.reason || 'guarded start failed'));
          if (ok && startResult.started === true) startIssued = true;
        } catch {
          record('start-guarded', false, 'guarded start failed');
        }
      }
      if (retryIdx >= opts.retryWaitMs.length) break;
      await runtime.sleep(opts.retryWaitMs[retryIdx]);
    }

    if (healthy) {
      state.consecutiveHostFailures = 0;
      state.circuitOpen = false;
      state.circuitOpenUntilMs = null;
      let observedPid = null;
      if (startIssued) {
        // Capture the started host PID for the record (read-only inspection).
        try {
          const insp = await runtime.inspect();
          record('inspect', !!insp && insp.ok !== false,
            insp && insp.ok === false ? (insp.reason || 'process inspection failed') : undefined);
          if (insp && insp.ok !== false) {
            observedPid = insp.primaryPid ?? insp.dsh?.primaryPid ?? null;
            lastInsp = insp;
          }
        } catch {
          record('inspect', false, 'process inspection failed');
        }
      }
      const taskInfo = opts.taskId ? await inspectTask(runtime, opts.taskId, record) : { ok: true, checkpoint: null };
      outcome.host = {
        healthy: true, recovered: startIssued, startedThisCall: startIssued,
        observedPid, foreignListener: false,
      };
      outcome.task = taskInfo.ok ? { ok: true, checkpoint: taskInfo.checkpoint } : { ok: false, reason: taskInfo.reason };
      outcome.status = taskInfo.ok ? 'healthy' : 'task-inspection-failed';
      outcome.exitCode = taskInfo.ok ? 0 : 4;
      if (!taskInfo.ok) outcome.reason = `task inspection failed (host healthy): ${taskInfo.reason}`;
    } else {
      const pidSeen = lastInsp ? (lastInsp.primaryPid ?? lastInsp.dsh?.primaryPid ?? null) : null;
      let reason;
      if (foreignSeen) {
        outcome.status = 'blocked';
        outcome.exitCode = 2;
        reason = 'port 3080 is held by a foreign listener; blocked, not replaced';
      } else if (!inspectionEverOk) {
        outcome.status = 'unavailable';
        reason = 'process inspection unavailable; host state could not be classified';
      } else if (lastInsp && lastInsp.listenerPresent && (lastInsp.dshPresent || lastInsp.ownsListener)) {
        reason = 'DSH host process is listening but the health probe failed';
      } else if (startAttempted && !startIssued) {
        reason = 'guarded start was not confirmed (busy, timeout or host state changed); startup may be ambiguous; no second start issued';
      } else if (startAttempted) {
        reason = 'start script ran but the host did not become healthy';
      } else if (lastInsp && lastInsp.dshPresent) {
        reason = 'matching DSH process present but host not ready; no duplicate start issued';
      } else {
        reason = 'no DSH host process or listener found';
      }
      outcome.reason = reason;
      outcome.host = {
        healthy: false, recovered: false, startedThisCall: startIssued,
        observedPid: pidSeen, foreignListener: foreignSeen ? true : (lastInsp ? lastInsp.foreignListener : null),
      };
      // Host-health accounting is strictly separate from task-status failures:
      // only unavailable/blocked outcomes advance the circuit.
      const failures = (state.consecutiveHostFailures || 0) + 1;
      state.consecutiveHostFailures = failures;
      if (state.circuitOpen && state.circuitOpenUntilMs && state.circuitOpenUntilMs > now()) {
        // already open and still failing: keep the original cooldown window
      } else if (failures >= opts.circuitThreshold) {
        state.circuitOpen = true;
        state.circuitOpenUntilMs = now() + opts.cooldownMs;
      } else {
        state.circuitOpen = false;
        state.circuitOpenUntilMs = null;
      }
    }

    outcome.attempts = attempts;
    outcome.circuit = emptyCircuit(state);
    await persistState(opts, state, outcome, attempts);
    return outcome;
  } finally {
    await releaseRecoveryLock(lock.lockPath, lock.nonce);
  }
}

async function inspectTask(runtime, taskId, record) {
  let result;
  try {
    result = await runtime.probeTask(taskId);
  } catch {
    record('probe-task', false, 'task status inspection failed');
    return { ok: false, reason: 'task status inspection failed' };
  }
  record('probe-task', result.ok, result.ok ? undefined : (result.reason || 'task status inspection failed'));
  if (result.ok && result.checkpoint) return { ok: true, checkpoint: result.checkpoint };
  return { ok: false, reason: result.reason || 'task status inspection failed' };
}

/**
 * Persist state. `state` is the freshly read previous state (its attempts and
 * task fields are preserved/merged). A successful task inspection replaces the
 * persisted checkpoint; a failed one keeps the previous successful checkpoint
 * and only records the failure (host accounting is untouched by task errors).
 */
async function persistState(opts, state, outcome, attempts) {
  const mergedAttempts = [...(Array.isArray(state.attempts) ? state.attempts : []), ...attempts]
    .slice(-opts.keepAttempts);

  let lastTaskId = typeof state.lastTaskId === 'string' ? state.lastTaskId : null;
  let lastTaskCheckpoint = isPlainObject(state.lastTaskCheckpoint) ? state.lastTaskCheckpoint : null;
  let lastTaskInspectionOk = state.lastTaskInspectionOk === true
    ? true : (state.lastTaskInspectionOk === false ? false : null);
  let taskFailureReason = typeof state.taskFailureReason === 'string' ? state.taskFailureReason : null;
  let taskInspectionAt = typeof state.taskInspectionAt === 'string' ? state.taskInspectionAt : null;
  if (typeof opts.taskId === 'string' && opts.taskId && outcome.task) {
    // Only actual inspection results touch persisted task evidence. When the
    // host was unavailable no inspection ran (outcome.task === null) and the
    // previous evidence is preserved untouched.
    lastTaskId = opts.taskId;
    taskInspectionAt = new Date().toISOString();
    if (outcome.task && outcome.task.ok === true && isPlainObject(outcome.task.checkpoint)) {
      lastTaskCheckpoint = outcome.task.checkpoint;
      lastTaskInspectionOk = true;
      taskFailureReason = null;
    } else {
      lastTaskInspectionOk = false;
      taskFailureReason = outcome.task && outcome.task.reason
        ? redact(outcome.task.reason) : 'task inspection failed';
    }
  }

  const openUntilMs = state.circuitOpenUntilMs || null;
  const next = {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    lastStatus: outcome.status,
    lastHostHealthy: outcome.host.healthy === true,
    lastHostStatus: outcome.status === 'unavailable' || outcome.status === 'blocked' || outcome.status === 'busy'
      ? outcome.status : (outcome.host.healthy === true ? 'healthy' : outcome.status),
    failureReason: outcome.reason ? redact(outcome.reason) : null,
    consecutiveHostFailures: state.consecutiveHostFailures || 0,
    circuitOpen: !!state.circuitOpen,
    circuitOpenUntilMs: state.circuitOpen ? openUntilMs : null,
    attempts: mergedAttempts,
    lastObservedHostPid: outcome.host.observedPid ?? null,
    lastRecovered: outcome.host.recovered === true,
    lastTaskId,
    lastTaskInspectionOk,
    lastTaskCheckpoint,
    taskFailureReason,
    taskInspectionAt,
  };
  await writeStateFileAtomically(opts, next);
}

/* ------------------------------------------------------------------ *
 * real runtime (fresh node subprocess for probes; powershell inspection)
 * ------------------------------------------------------------------ */

/**
 * Spawn a helper subprocess and resolve only after 'close' (stdio fully
 * drained).  Returns { code, signal, timedOut, error, stdout, stderr }.
 * On timeout only a still-live owned subprocess is terminated:
 *   - treeKillOnTimeout=true  -> taskkill /T /F on our own probe tree, then
 *                                wait for termination (close or short grace),
 *                                so children are not orphaned and PID reuse
 *                                races are minimized.
 *   - treeKillOnTimeout=false -> stop just the helper (guarded start): a Host
 *                                that Start-DSH.ps1 launched is a descendant
 *                                and must NOT be killed; report timedOut and
 *                                let the caller re-probe.
 */
export function runSubprocess(exec, args, { timeoutMs = 0, treeKillOnTimeout = true, spawnImpl = spawn, platform = process.platform, killImpl = process.kill } = {}) {
  return new Promise(resolve => {
    const child = spawnImpl(exec, args, { windowsHide: true, detached: platform !== 'win32' && treeKillOnTimeout, stdio: ['ignore', 'pipe', 'pipe'] });
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutTimer = null;
    let graceTimer = null;
    const STDOUT_CAP = 4_000_000;
    const STDERR_CAP = 500_000;
    const finish = extra => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        code: extra.code ?? null,
        signal: extra.signal ?? null,
        timedOut,
        error: extra.error ?? null,
        stdout,
        stderr,
      });
    };
    child.stdout.on('data', chunk => {
      const text = outDecoder.write(chunk);
      if (text && stdout.length < STDOUT_CAP) stdout += text.length > STDOUT_CAP - stdout.length
        ? text.slice(0, STDOUT_CAP - stdout.length) : text;
    });
    child.stderr.on('data', chunk => {
      const text = errDecoder.write(chunk);
      if (text && stderr.length < STDERR_CAP) stderr += text.length > STDERR_CAP - stderr.length
        ? text.slice(0, STDERR_CAP - stderr.length) : text;
    });
    child.on('error', error => finish({ code: null, error }));
    // 'close' fires only after both stdio streams are fully closed -> drained.
    child.on('close', (code, signal) => finish({ code, signal }));
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        const pid = child.pid;
        timedOut = true;
        if (!pid || child.exitCode !== null || child.signalCode !== null) {
          // A departed parent may leave inherited pipes open in descendants.
          // Never target its recycled PID, but still honor the caller deadline.
          child.stdout.destroy(); child.stderr.destroy();
          finish({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        if (treeKillOnTimeout && platform === 'win32') {
          // Kill only OUR OWN probe subprocess tree (never a host/foreign proc).
          try {
            const killer = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'],
              { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => { try { child.kill(); } catch {} });
          } catch { /* ignore */ }
        } else if (treeKillOnTimeout) {
          try { killImpl(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        } else {
          try { child.kill(); } catch { /* already gone */ }
        }
        // Wait for actual termination ('close'); escalate to a grace timer so a
        // stuck child cannot hold the caller forever.
        graceTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish({ code: null }); }, 2500);
      }, timeoutMs);
    }
  });
}

function isCompleteInspection(json) {
  const listener = json.listener;
  const dsh = json.dsh;
  return !!listener && typeof listener === 'object' && typeof listener.present === 'boolean' &&
    Array.isArray(listener.pids) &&
    !!dsh && typeof dsh === 'object' && typeof dsh.present === 'boolean' &&
    Array.isArray(dsh.pids) &&
    typeof json.ownsListener === 'boolean' && typeof json.foreignListener === 'boolean';
}

/** Normalize a powershell inspection spawn result. Fails closed: honors exit
 *  code / timedOut / spawn error and rejects incomplete payloads such as {}.
 *  Missing listener/dsh sections are NEVER treated as absence. */
export function normalizeInspection(res) {
  if (!res) return { ok: false, reason: 'process inspection unavailable' };
  if (res.timedOut) return { ok: false, reason: 'process inspection timed out' };
  if (res.error) return { ok: false, reason: 'process inspection could not be started' };
  const json = parseLooseJson(res.stdout);
  if (json && json.ok === false) {
    return { ok: false, reason: json.error ? redact(json.error) : 'process inspection unavailable' };
  }
  if (res.code !== 0) {
    return { ok: false, reason: json
      ? `process inspection exited ${res.code}`
      : `process inspection returned no parseable JSON (exit ${res.code})` };
  }
  if (!json) return { ok: false, reason: 'process inspection returned no parseable JSON' };
  if (!isCompleteInspection(json)) {
    return { ok: false, reason: 'process inspection returned an incomplete payload' };
  }
  const listener = json.listener;
  const dsh = json.dsh;
  const intList = list => list.map(Number).filter(Number.isInteger);
  return {
    ok: true,
    listenerPresent: listener.present === true,
    listenerPids: intList(listener.pids),
    dshPresent: dsh.present === true,
    dshPids: intList(dsh.pids),
    primaryPid: Number.isInteger(dsh.primaryPid) ? dsh.primaryPid : null,
    primaryStartEpochMs: Number.isFinite(dsh.primaryStartEpochMs) ? dsh.primaryStartEpochMs : null,
    ownsListener: json.ownsListener === true,
    foreignListener: json.foreignListener === true,
  };
}

function normalizeGuardResult(res) {
  if (res.timedOut) {
    return { ok: false, reason: 'guarded start timed out; host startup ambiguous', timedOut: true };
  }
  if (res.error) return { ok: false, reason: 'guarded start could not be started' };
  const json = parseLooseJson(res.stdout);
  if (json && json.ok === false) {
    return { ok: false, reason: json.error ? redact(json.error) : 'guarded start unavailable' };
  }
  if (res.code !== 0) {
    return { ok: false, reason: json
      ? `guarded start exited ${res.code}`
      : `guarded start returned no parseable JSON (exit ${res.code})` };
  }
  if (!json || !json.startGuard || typeof json.startGuard !== 'object') {
    return { ok: false, reason: 'guarded start returned an incomplete payload' };
  }
  const guard = json.startGuard;
  return {
    ok: true,
    started: guard.started === true,
    detail: guard.detail ? redact(String(guard.detail)) : undefined,
  };
}

function resolvePowershell() {
  const candidates = [];
  if (process.env.SystemRoot) {
    candidates.push(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }
  candidates.push('powershell.exe');
  for (const candidate of candidates) {
    try { accessSync(candidate); return candidate; } catch { /* next */ }
  }
  return 'powershell.exe';
}

function isAliveReal(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  try {
    process.kill(pid, 0);
    return Promise.resolve(true);
  } catch (error) {
    return Promise.resolve(error && (error.code === 'EPERM' || error.code === 'EACCES'));
  }
}

export function createRealRuntime(opts) {
  const powershell = resolvePowershell();
  const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));
  return {
    now: () => Date.now(),
    sleep: timeout,
    isAlive: isAliveReal,

    async probeHost() {
      const res = await runSubprocess(process.execPath, [opts.invokePath, 'dsh_host_status'],
        { timeoutMs: opts.probeTimeoutMs, treeKillOnTimeout: true });
      return classifyHostProbe(res);
    },

    async inspect() {
      if (process.platform !== 'win32') return normalizeInspection(await runSubprocess(process.execPath, [join(here, 'host-process-posix.mjs')], { timeoutMs: opts.processTimeoutMs, treeKillOnTimeout: true }));
      const res = await runSubprocess(powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', opts.hostProcessPs,
         '-Port', String(opts.port), '-HostAddr', opts.hostAddr, '-EntryPath', opts.hostEntry,
         '-NodeExe', opts.nodeExe],
        { timeoutMs: opts.processTimeoutMs, treeKillOnTimeout: true });
      return normalizeInspection(res);
    },

    async guardedStart() {
      if (!opts.autoStart) return { ok: true, started: false, detail: 'autoStart is disabled in the local configuration; use Codex fallback or complete setup.' };
      if (process.platform !== 'win32') return normalizeGuardResult(await runSubprocess(process.execPath, [join(here, 'host-process-posix.mjs'), '--start-guard'], { timeoutMs: opts.startTimeoutMs, treeKillOnTimeout: false }));
      const res = await runSubprocess(powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', opts.hostProcessPs,
         '-StartGuard', '-MutexWaitMs', String(opts.mutexWaitMs),
         '-Port', String(opts.port), '-HostAddr', opts.hostAddr, '-EntryPath', opts.hostEntry,
         '-NodeExe', opts.nodeExe, '-StartScript', opts.startScript],
        // Never tree-kill a guarded start: a host launched by Start-DSH.ps1 is
        // a descendant of this helper. On timeout stop only the helper and let
        // the caller re-probe (startup is reported ambiguous).
        { timeoutMs: opts.startTimeoutMs, treeKillOnTimeout: false });
      return normalizeGuardResult(res);
    },

    async probeTask(taskId) {
      const inputDir = join(opts.stateDir, 'task-inputs');
      await mkdir(inputDir, { recursive: true });
      const inputFile = join(inputDir, `task-${taskId}-${process.pid}-${randomUUID()}.json`);
      let created = false;
      try {
        const handle = await open(inputFile, 'wx');
        try { await handle.writeFile(JSON.stringify({ taskId }), 'utf8'); } finally { await handle.close(); }
        created = true;
        const res = await runSubprocess(process.execPath,
          [opts.invokePath, 'dsh_status', inputFile],
          { timeoutMs: opts.probeTimeoutMs, treeKillOnTimeout: true });
        if (res.timedOut) return { ok: false, reason: 'task status probe timed out' };
        if (res.error) return { ok: false, reason: 'task status probe could not be started' };
        if (res.code !== 0 && res.code !== 1) {
          return { ok: false, reason: `task status probe exited ${res.code}` };
        }
        const outer = parseLooseJson(res.stdout);
        if (!outer) return { ok: false, reason: `task status probe returned no parseable JSON (exit ${res.code})` };
        if (!isPlainObject(outer) || !Array.isArray(outer.content)) {
          return { ok: false, reason: 'task status probe returned an incomplete payload' };
        }
        if (outer.isError === true) {
          return { ok: false, reason: redact(contentText(outer) || 'task status error') };
        }
        const text = contentText(outer);
        if (!text) return { ok: false, reason: 'task status probe returned an empty payload' };
        const inner = parseLooseJson(text);
        if (!inner || !isPlainObject(inner)) {
          return { ok: false, reason: 'task status returned no usable payload' };
        }
        if (inner.taskId !== taskId) return { ok: false, reason: 'task status returned mismatched taskId' };
        return { ok: true, checkpoint: pickCheckpoint(inner) };
      } finally {
        if (created) { try { await unlink(inputFile); } catch { /* best effort */ } }
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * entry point
 * ------------------------------------------------------------------ */

function printJson(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    printJson({
      tool: 'dsh-recover', version: VERSION, ok: false,
      status: parsed.help ? 'help' : 'usage',
      exitCode: parsed.exitCode,
      usage: 'node dsh-recover.mjs [--task-id ID] [--state-dir ABS_DIR]',
      reason: parsed.error || undefined,
      defaultStateDir: DEFAULTS.stateDir,
    });
    process.exit(parsed.exitCode);
  }
  const config = loadConfig();
  const opts = {
    ...DEFAULTS,
    hostEntry: join(config.dsh.installDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    nodeExe: process.execPath,
    port: config.dsh.port, hostAddr: config.dsh.hostAddr, autoStart: config.dsh.autoStart,
    stateDir: process.argv.some(a => a === '--state-dir' || a.startsWith('--state-dir='))
      ? parsed.stateDir : join(config.dsh.stateDir, 'recovery'),
    taskId: parsed.taskId,
  };
  const runtime = createRealRuntime(opts);
  let outcome;
  try {
    outcome = await runRecovery(runtime, opts);
  } catch (error) {
    outcome = internalErrorOutcome(redact(error && error.message ? error.message : String(error)));
  }
  printJson({
    tool: 'dsh-recover', version: VERSION,
    ok: outcome.exitCode === 0,
    status: outcome.status,
    exitCode: outcome.exitCode,
    at: new Date().toISOString(),
    stateDir: opts.stateDir,
    taskId: opts.taskId || null,
    host: outcome.host,
    circuit: outcome.circuit,
    attempts: outcome.attempts,
    reason: outcome.reason || null,
    task: outcome.task || null,
  });
  process.exit(outcome.exitCode);
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main().catch(error => {
    printJson({
      tool: 'dsh-recover', version: VERSION, ok: false, status: 'internal-error', exitCode: 6,
      at: new Date().toISOString(), host: emptyHost(),
      circuit: { open: false, openUntil: null, consecutiveFailures: 0 },
      attempts: [], reason: redact(error && error.message ? error.message : String(error)), task: null,
    });
    process.exit(6);
  });
}
