import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { runCodex } from '../../prototype/codex.mjs';
import { costOf } from '../../prototype/usage.mjs';
const [caseId, arm, runId = 'pilot-01'] = process.argv.slice(2);
if (!['astra','dsh-alone','dsh-advisor'].includes(arm) || !/^[a-z0-9-]+$/.test(caseId || '') || !/^[a-z0-9-]+$/.test(runId)) throw Error('Usage: node run-arm.mjs CASE astra|dsh-alone|dsh-advisor [RUN]');
const base = resolve('.local-runs/dsh-led', runId, caseId), directory = join(base, arm);
const spec = JSON.parse(await readFile(join(directory, 'spec.json'), 'utf8'));
if (spec.workflowConfig) process.env.WORKFLOW_CONFIG = spec.workflowConfig;
const { runDsh } = await import('../../prototype/runner.mjs');
const started = Date.now();
const record = arm === 'astra' ? await runCodex({ ...spec, prompt: spec.task, timeoutMs: 600000 })
  : await runDsh({ ...spec, onProgress: value => console.log(JSON.stringify(value)) });
const safeToEvaluate = arm === 'astra' ? !record.timedOut && record.exitCode !== null : record.idleVerified;
const acceptance = safeToEvaluate ? await new Promise(done => {
  const child = spawn(process.execPath, ['--test', join(base, 'acceptance.mjs')], { cwd: spec.cwd, env: { ...process.env, TARGET_CWD: spec.cwd }, windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
  child.on('error', e => done({ exitCode: null, stdout, error: e.code }));
  const timer = setTimeout(() => child.kill(), 30000);
  child.on('close', code => { clearTimeout(timer); done({ exitCode: code, stdout, stderr }); });
}) : { exitCode: null, skipped: 'writer is not proven idle' };
const summary = { caseId, arm, elapsedMs: Date.now() - started, executionElapsedMs: record.elapsedMs,
  acceptance, passed: acceptance.exitCode === 0, completed: arm === 'astra' ? record.exitCode === 0 && !record.timedOut : record.completed,
  cost: arm === 'astra' ? costOf(record.usageEvents, 'astra') : record.cost,
  consultations: (record.consultations || []).map(c => ({ decision: c.decision, status: c.status, cost: c.cost, elapsedMs: c.expert?.elapsedMs })),
  error: record.error ?? null,
};
await writeFile(join(directory, 'result.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
