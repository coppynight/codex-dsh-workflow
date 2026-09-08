import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function validateArguments(directory, id) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) {
    throw new TypeError('directory must be an absolute path without NUL characters');
  }
  if (typeof id !== 'string' || id.length < 1 || id.length > 64 || /[^A-Za-z0-9_-]/.test(id)) {
    throw new TypeError('id must contain 1–64 ASCII letters, digits, underscores, or hyphens');
  }
}

function normalizeValue(value, id) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('checkpoint must be an object');
  }

  const { version, taskId, phase, updatedAt, operationIds } = value;
  if (version !== 1) throw new TypeError('version must be 1');
  if (typeof taskId !== 'string' || taskId !== id) {
    throw new TypeError('taskId must equal id');
  }
  if (!['planned', 'running', 'completed', 'failed'].includes(phase)) {
    throw new TypeError('invalid phase');
  }
  if (!Number.isFinite(updatedAt) || !Number.isInteger(updatedAt) || updatedAt < 0) {
    throw new TypeError('updatedAt must be a nonnegative finite integer');
  }
  if (!Array.isArray(operationIds)) {
    throw new TypeError('operationIds must be an array');
  }

  const operations = [];
  const seen = new Set();
  const length = operationIds.length;
  for (let i = 0; i < length; i += 1) {
    const operation = operationIds[i];
    if (typeof operation !== 'string' || operation.length === 0 || seen.has(operation)) {
      throw new TypeError('operationIds must contain unique nonempty strings');
    }
    seen.add(operation);
    operations.push(operation);
  }

  return { version, taskId, phase, updatedAt, operationIds: operations };
}

export async function saveCheckpoint(directory, id, value) {
  validateArguments(directory, id);
  const saved = normalizeValue(value, id);
  const data = JSON.stringify(saved) + '\n';
  const destination = join(directory, id + '.json');

  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${id}.${randomUUID()}.tmp`);
  let handle;
  let ownsTemporary = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    await handle.writeFile(data, { encoding: 'utf8' });
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    ownsTemporary = false;
    return saved;
  } catch (error) {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* Preserve the original failure. */ }
    }
    if (ownsTemporary) {
      try { await unlink(temporary); } catch { /* Cleanup may fail; preserve the original failure. */ }
    }
    throw error;
  }
}

export async function loadCheckpoint(directory, id) {
  validateArguments(directory, id);
  let bytes;
  try {
    bytes = await readFile(join(directory, id + '.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return normalizeValue(JSON.parse(text), id);
}
