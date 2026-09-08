import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claimJob, readJob, finishJob } from './jobs.mjs';

const execute = promisify(execFile);
async function fixture(fn) {
  const base = resolve(process.cwd());
  const dir = await mkdtemp(join(base, '.receipt-test-'));
  try { await fn(dir); }
  finally {
    if (!dir.startsWith(base + sep) || !dir.slice(base.length + 1).startsWith('.receipt-test-')) throw Error('Cleanup boundary');
    await rm(dir, { recursive: true, force: true });
  }
}
async function child(root, operation, value) {
  const source = `import {claimJob,finishJob} from ${JSON.stringify(new URL('./jobs.mjs', import.meta.url).href)};
    try { console.log(JSON.stringify(await ${operation}(process.argv[1], 'race', JSON.parse(process.argv[2])))); }
    catch(e) { console.log(JSON.stringify({code:e.code})); }`;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', source, root, JSON.stringify(value)], { timeout: 5000 });
  return JSON.parse(stdout);
}

test('six independent claimants and conflicting finishers', async t => {
  try { await execute(process.execPath, ['-e', ''], { timeout: 5000 }); }
  catch (error) {
    if (error.code === 'EPERM' && error.syscall === 'spawn') {
      t.skip('Sandbox prohibits child-process creation');
      return;
    }
    throw error;
  }
  await fixture(async dir => {
  const claims = await Promise.all(Array.from({ length: 6 }, () => child(dir, 'claimJob', { a: 1 })));
  assert.equal(claims.filter(x => x.created === true).length, 1);
  assert.equal(claims.filter(x => x.created === false).length, 5);
  const completions = await Promise.all(Array.from({ length: 6 }, (_, i) => child(dir, 'finishJob', i)));
  const winners = completions.filter(x => x.state === 'completed');
  assert.equal(winners.length, 1);
  assert.equal(completions.filter(x => x.code === 'JOB_CONFLICT').length, 5);
  assert.deepEqual(await readJob(dir, 'race'), winners[0]);
  });
});

test('concurrent writers serialize and readers see complete records', () => fixture(async dir => {
  const claims = await Promise.all(Array.from({ length: 6 }, () => claimJob(dir, 'race', {})));
  assert.equal(claims.filter(x => x.created).length, 1);
  const attempts = Array.from({ length: 6 }, (_, i) => finishJob(dir, 'race', { i, data: 'x'.repeat(100000) }));
  const reads = Array.from({ length: 30 }, async () => {
    const record = await readJob(dir, 'race');
    assert.ok(['pending', 'completed'].includes(record.state));
    if (record.state === 'completed') assert.equal(record.result.data.length, 100000);
  });
  const results = await Promise.allSettled(attempts);
  await Promise.all(reads);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected' && x.reason.code === 'JOB_CONFLICT').length, 5);
}));

test('arbitrary keys, snapshot isolation, and semantic replay', () => fixture(async dir => {
  for (const id of ['constructor', '__proto__', '../payment/客户', '💳']) {
    const payload = JSON.parse('{"__proto__":{"x":1},"constructor":2,"nested":[null,true]}');
    const result = await claimJob(dir, id, payload);
    payload.__proto__.x = 99;
    result.record.payload.nested.push('mutated');
    const replay = await claimJob(dir, id, JSON.parse('{"nested":[null,true],"constructor":2,"__proto__":{"x":1}}'));
    assert.equal(replay.created, false);
    assert.equal(replay.record.payload.__proto__.x, 1);
    await assert.rejects(claimJob(dir, id, {}), { code: 'JOB_CONFLICT' });
    await finishJob(dir, id, { b: 2, a: 1 });
    assert.equal((await finishJob(dir, id, { a: 1, b: 2 })).state, 'completed');
  }
  assert.equal((await readdir(dir)).length, 4);
}));

test('invalid input causes no durable changes; corrupt receipts are preserved', () => fixture(async dir => {
  const cycle = {}; cycle.self = cycle;
  const values = [undefined, NaN, Infinity, () => {}, new Date(), cycle, { x: undefined }, [undefined], new Array(2)];
  const missing = join(dir, 'missing');
  assert.equal(await readJob(missing, 'id'), null);
  for (const value of values) {
    await assert.rejects(claimJob(missing, 'id', value), { code: 'INVALID_INPUT' });
    await assert.rejects(finishJob(missing, 'id', value), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(await readdir(dir), []);
  const file = join(dir, createHash('sha256').update('id').digest('hex') + '.json');
  for (const bad of ['{', '{}', '{"version":1,"id":"id","payload":1e999,"state":"pending"}']) {
    await writeFile(file, bad);
    await assert.rejects(readJob(dir, 'id'), { code: 'JOB_CORRUPT' });
    await assert.rejects(claimJob(dir, 'id', {}), { code: 'JOB_CORRUPT' });
    await assert.rejects(finishJob(dir, 'id', {}), { code: 'JOB_CORRUPT' });
  }
}));
