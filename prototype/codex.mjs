import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Uses the official installed client and its own authentication. No key handling.
// Raw JSONL can contain reasoning: callers must keep outputDir private.
export async function runCodex({ cwd, prompt, outputDir, role = 'executor', timeoutMs = 180000, model = 'gpt-6-astra', abortSignal }) {
  if (abortSignal?.aborted) throw Error('Cancelled before model submission');
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'prompt.txt'), prompt, { flag: 'wx' });
  await writeFile(join(outputDir, 'record.json'), JSON.stringify({ role, requestedModel: model, phase: 'started', usageEvents: [], cleanupVerified: false }), { flag: 'wx' });
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-m', model,
    '-c', 'model_reasoning_effort="medium"', '-C', resolve(cwd)];
  if (role === 'advisor') args.push('-s', 'read-only');
  else args.push('--approve-for-me');
  args.push('-');
  const started = Date.now();
  const child = spawn(process.env.CODEX_EXECUTABLE || (process.platform === 'win32' ? 'codex.exe' : 'codex'), args,
    { windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false, launchError = null, cleanupVerified = true, cancelled = false, settle;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', () => {});
  const completion = new Promise(done => {
    settle = done;
    child.once('error', error => { launchError = error.code || error.name; done(null); });
    child.once('close', done);
  });
  await writeFile(join(outputDir, 'process.json'), JSON.stringify({ pid: child.pid ?? null, args, startedAt: new Date(started).toISOString() }));
  let grace;
  const stop = () => {
    cleanupVerified = false;
    // Never kill a stale/reused PID after the direct child has exited.
    if (child.exitCode !== null || child.signalCode !== null) {
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); settle(null); return;
    }
    if (process.platform === 'win32' && child.pid) {
      // This PID was created by this invocation. Never target names or other sessions.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {});
      killer.once('close', code => { if (code === 0) cleanupVerified = true; });
    } else {
      // A dedicated POSIX process group contains tools launched by this client.
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Unknown until proven absent. */ }
    }
    grace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref(); settle(null); }, 10000);
  };
  const abort = () => { cancelled = true; stop(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  abortSignal?.addEventListener('abort', abort, { once: true });
  if (abortSignal?.aborted) abort();
  child.stdin.end(prompt);
  const exitCode = await completion;
  clearTimeout(timer); clearTimeout(grace); abortSignal?.removeEventListener('abort', abort);
  await writeFile(join(outputDir, 'private-raw.jsonl'), stdout);
  await writeFile(join(outputDir, 'private-stderr.log'), stderr);
  let parseErrors = 0;
  const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { parseErrors++; return []; } });
  const items = events.filter(e => e.type === 'item.completed').map(e => e.item);
  const record = {
    requestedModel: model, modelVerification: 'requested; CLI event stream may not report actual model', role,
    startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started,
    exitCode, timedOut, cancelled, cleanupVerified, launchError, parseErrors,
    usageEvents: events.filter(e => e.type === 'turn.completed' && e.usage).map(e => ({ usage: e.usage })),
    failures: events.filter(e => ['error', 'turn.failed'].includes(e.type)),
    answer: items.filter(i => i?.type === 'agent_message').map(i => i.text).join('\n'),
    toolResults: items.filter(i => !['agent_message', 'reasoning', 'todo_list', 'plan', 'user_message'].includes(i?.type)),
  };
  await writeFile(join(outputDir, 'record.json'), JSON.stringify(record, null, 2));
  return record;
}
