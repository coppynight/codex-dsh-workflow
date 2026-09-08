import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseJobs } from './parse.mjs';
import { summarizeJobs } from './aggregate.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write('Usage: node cli.mjs INPUT OUTPUT\n');
    process.exitCode = 1;
    return;
  }

  let temporaryPath;
  let ownsTemporary = false;
  let handle;
  let failureMessage = 'Unable to resolve file paths.';

  try {
    const inputPath = resolve(args[0]);
    const outputPath = resolve(args[1]);
    if (inputPath === outputPath) {
      process.stderr.write('Input and output paths must differ.\n');
      process.exitCode = 1;
      return;
    }

    failureMessage = 'Unable to read input.';
    const text = await readFile(inputPath, 'utf8');

    failureMessage = 'Unable to prepare report.';
    const { jobs, errors } = parseJobs(text);
    const report = JSON.stringify({ summary: summarizeJobs(jobs), errors }, null, 2) + '\n';

    failureMessage = 'Unable to write output.';
    const parent = dirname(outputPath);
    await mkdir(parent, { recursive: true });
    temporaryPath = join(parent, `.job-report-${randomUUID()}.tmp`);
    handle = await open(temporaryPath, 'wx', 0o600);
    ownsTemporary = true;
    await handle.writeFile(report, 'utf8');
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
    ownsTemporary = false;
    process.exitCode = errors.length === 0 ? 0 : 2;
  } catch {
    process.exitCode = 1;
    process.stderr.write(failureMessage + '\n');
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        process.exitCode = 1;
      }
    }
    if (ownsTemporary) {
      try {
        await unlink(temporaryPath);
      } catch {
        process.exitCode = 1;
        process.stderr.write('Unable to remove temporary report.\n');
      }
    }
  }
}

await main();
