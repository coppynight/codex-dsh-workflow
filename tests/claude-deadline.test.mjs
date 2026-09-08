import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { run } from '../scripts/claude-review.mjs';

test('Claude timeout resolves within cleanup grace even when descendant-held pipes never close', async () => {
  let killed = false;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => { killed = true; return true; } });
  const started = Date.now();
  const result = await run([], process.cwd(), 'test', 20, undefined, () => child);
  assert.equal(killed, true); assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3500);
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
});
