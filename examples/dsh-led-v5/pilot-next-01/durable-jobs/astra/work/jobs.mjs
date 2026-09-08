import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

function fault(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

// Snapshot before the first await, without invoking getters or toJSON methods.
function snapshot(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw fault('INVALID_INPUT', 'Expected an acyclic JSON value');
  }
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw fault('INVALID_INPUT', 'Expected a plain JSON object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string')) throw fault('INVALID_INPUT', 'Symbol keys are not JSON');
  if (array && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' &&
      (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)))) {
    throw fault('INVALID_INPUT', 'Expected a dense JSON array without extra properties');
  }
  ancestors.add(value);
  const copy = array ? [] : {};
  try {
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw fault('INVALID_INPUT', 'Expected enumerable data properties');
      }
      Object.defineProperty(copy, key, {
        value: snapshot(descriptor.value, ancestors), enumerable: true, writable: true, configurable: true,
      });
    }
  } finally {
    ancestors.delete(value);
  }
  return copy;
}

function equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' ||
      Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

function paths(root, id) {
  if (typeof root !== 'string' || !root.length || root.includes('\0') || typeof id !== 'string' || !id.length) {
    throw fault('INVALID_INPUT', 'root and id must be nonempty strings; root must be a valid path');
  }
  const hash = createHash('sha256').update(id, 'utf8').digest('hex');
  return { file: join(root, `${hash}.json`), lock: join(root, `${hash}.lock`) };
}

async function read(file, id) {
  let data;
  try { data = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const record = JSON.parse(data);
    if (record === null || Array.isArray(record) || typeof record !== 'object' ||
        record.version !== 1 || record.id !== id || !Object.hasOwn(record, 'payload') ||
        !['pending', 'completed'].includes(record.state)) throw new Error('Invalid receipt schema');
    const expected = record.state === 'pending' ? ['version', 'id', 'payload', 'state'] : ['version', 'id', 'payload', 'state', 'result'];
    if (Object.keys(record).length !== expected.length || !expected.every(key => Object.hasOwn(record, key))) {
      throw new Error('Invalid receipt fields');
    }
    return snapshot(record);
  } catch (error) { throw fault('JOB_CORRUPT', `Invalid receipt for ${JSON.stringify(id)}`, error); }
}

async function locked(lock, action) {
  const start = performance.now();
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (performance.now() - start >= 5000) throw fault('BUSY', 'Receipt lock remained occupied for five seconds');
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }
  try { return await action(); }
  finally { await rmdir(lock); }
}

async function syncDirectory(root) {
  let handle;
  try {
    handle = await open(root, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory fsync through Node on all filesystems.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

async function publish(root, file, record) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(record), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await syncDirectory(root);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function claimJob(root, id, payload) {
  const { file, lock } = paths(root, id);
  const input = snapshot(payload);
  await mkdir(root, { recursive: true });
  return locked(lock, async () => {
    const existing = await read(file, id);
    if (existing) {
      if (!equal(existing.payload, input)) throw fault('JOB_CONFLICT', 'Job payload differs from the original claim');
      return { created: false, record: existing };
    }
    const record = { version: 1, id, payload: input, state: 'pending' };
    await publish(root, file, record);
    return { created: true, record };
  });
}

export async function readJob(root, id) {
  const { file } = paths(root, id);
  return read(file, id);
}

export async function finishJob(root, id, result) {
  const { file, lock } = paths(root, id);
  const input = snapshot(result);
  // Do not create a directory for an unknown job.
  if (await read(file, id) === null) throw fault('JOB_UNKNOWN', 'Job has not been claimed');
  return locked(lock, async () => {
    const existing = await read(file, id);
    if (!existing) throw fault('JOB_UNKNOWN', 'Job has not been claimed');
    if (existing.state === 'completed') {
      if (!equal(existing.result, input)) throw fault('JOB_CONFLICT', 'Job result differs from the recorded completion');
      return existing;
    }
    const record = { ...existing, state: 'completed', result: input };
    await publish(root, file, record);
    return record;
  });
}
