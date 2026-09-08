// cli.mjs — offline job-report tool: node cli.mjs INPUT OUTPUT
// Reads INPUT as UTF-8, publishes {summary, errors} atomically to OUTPUT.
// Exit codes: 0 = published, no parser errors; 2 = published, parser errors;
// 1 = argument/read/write failure (nothing about report data is printed).

import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseJobs } from './parse.mjs';
import { summarizeJobs } from './aggregate.mjs';

function describeError(err) {
  if (err && typeof err.code === 'string' && err.code !== '') {
    return err.code;
  }
  if (err && typeof err.name === 'string' && err.name !== '') {
    return err.name;
  }
  return 'error';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write('usage: node cli.mjs INPUT OUTPUT\n');
    return 1;
  }
  const [inputArg, outputArg] = args;
  const resolvedInput = path.resolve(inputArg);
  const resolvedOutput = path.resolve(outputArg);
  if (resolvedInput === resolvedOutput) {
    process.stderr.write('error: INPUT and OUTPUT must be different files\n');
    return 1;
  }

  // Read the complete input before creating any output directory or file, so
  // an input-read failure never touches (or destroys) an existing OUTPUT.
  let text;
  try {
    text = await readFile(resolvedInput, 'utf8');
  } catch (err) {
    process.stderr.write(`error: cannot read INPUT (${describeError(err)})\n`);
    return 1;
  }

  const { jobs, errors } = parseJobs(text);
  const summary = summarizeJobs(jobs);
  const report = JSON.stringify({ summary, errors }, null, 2) + '\n';

  try {
    await mkdir(path.dirname(resolvedOutput), { recursive: true });
  } catch (err) {
    process.stderr.write(
      `error: cannot create OUTPUT directory (${describeError(err)})\n`,
    );
    return 1;
  }

  // Publish atomically: exclusively create a uniquely named sibling temp
  // file, write the full report, close it, then rename onto OUTPUT. OUTPUT
  // is never deleted or truncated ahead of a successful rename.
  let tempPath = null;
  let handle = null;
  try {
    const outputDir = path.dirname(resolvedOutput);
    const outputBase = path.basename(resolvedOutput);
    for (;;) {
      const candidate = path.join(
        outputDir,
        `.${outputBase}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
      );
      try {
        handle = await open(candidate, 'wx'); // exclusive create
        tempPath = candidate; // ownership established only after success
        break;
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          continue; // name collision: pick a new random name, never delete
        }
        throw err;
      }
    }
    try {
      await handle.writeFile(report, 'utf8');
    } finally {
      await handle.close();
      handle = null;
    }
    await rename(tempPath, resolvedOutput);
    tempPath = null; // no longer ours to clean up
  } catch (err) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // best effort
      }
      handle = null;
    }
    if (tempPath !== null) {
      try {
        await unlink(tempPath); // remove only the temp file we created
      } catch {
        // best effort
      }
    }
    process.stderr.write(`error: cannot write OUTPUT (${describeError(err)})\n`);
    return 1;
  }

  return errors.length > 0 ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`error: ${describeError(err)}\n`);
    process.exitCode = 1;
  },
);
