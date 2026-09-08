import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
const PHASES = new Set(['planned', 'running', 'completed', 'failed']);

function requireArgs(directory, id) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) {
    throw new TypeError('directory must be an absolute path without null bytes');
  }
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TypeError('id must contain 1–64 ASCII letters, digits, underscores, or hyphens');
  }
}

function normalizeValue(value, id) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('checkpoint value must be an object');
  }

  // Read each required property once so validation and persistence agree.
  const { version, taskId, phase, updatedAt, operationIds } = value;
  if (version !== 1) {
    throw new TypeError('version must be 1');
  }
  if (typeof taskId !== 'string' || taskId !== id) {
    throw new TypeError('taskId must equal id');
  }
  if (!PHASES.has(phase)) {
    throw new TypeError('invalid checkpoint phase');
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
  for (let index = 0; index < length; index++) {
    const operation = operationIds[index];
    if (typeof operation !== 'string' || operation.length === 0 || seen.has(operation)) {
      throw new TypeError('operationIds must contain unique nonempty strings');
    }
    seen.add(operation);
    operations.push(operation);
  }

  return { version, taskId, phase, updatedAt, operationIds: operations };
}

export async function saveCheckpoint(directory, id, value) {
  requireArgs(directory, id);
  const normalized = normalizeValue(value, id);
  const contents = JSON.stringify(normalized) + '\n';
  const destination = join(directory, `${id}.json`);
  const temporary = join(directory, `.${id}.${randomUUID()}.tmp`);
  let handle;
  let ownsTemporary = false;

  try {
    await mkdir(directory, { recursive: true });
    handle = await open(temporary, 'wx');
    ownsTemporary = true;
    await handle.writeFile(contents, 'utf8');
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    ownsTemporary = false;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the original failure while attempting cleanup.
      }
    }
    if (ownsTemporary) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          throw new AggregateError([error, cleanupError], 'Checkpoint save and temporary-file cleanup failed');
        }
      }
    }
    throw error;
  }

  return normalized;
}

export async function loadCheckpoint(directory, id) {
  requireArgs(directory, id);
  const filename = join(directory, `${id}.json`);
  let bytes;
  try {
    bytes = await readFile(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  let parsed;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`Malformed JSON or UTF-8 in checkpoint ${filename}`, { cause: error });
  }
  return normalizeValue(parsed, id);
}
