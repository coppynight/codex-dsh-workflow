import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { runCodex } from '../../prototype/codex.mjs';
const root = resolve('.local-runs/dsh-led/native-probe-01');
const cwd = join(root, 'work');
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, 'input.txt'), 'native-probe-70931', { flag: 'wx' });
await writeFile(join(cwd, 'check.mjs'), "import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';assert.equal(readFileSync('output.txt','utf8'),'NATIVE-PROBE-70931');console.log('probe passed');\n", { flag: 'wx' });
const record = await runCodex({ cwd, outputDir: join(root, 'capture'), timeoutMs: 120000,
  prompt: 'Capability probe in this isolated task directory: read input.txt, write its uppercase contents exactly (without adding a newline) to output.txt, then run node check.mjs. Do not alter input.txt or check.mjs. Report the actual result. This is an authorized reversible local file operation. Stop and report if a tool policy denies execution; do not bypass it.' });
let actual = null; try { actual = await readFile(join(cwd, 'output.txt'), 'utf8'); } catch {}
console.log(JSON.stringify({ ok: actual === 'NATIVE-PROBE-70931', exitCode: record.exitCode, elapsedMs: record.elapsedMs, usage: record.usageEvents, answer: record.answer, failures: record.failures }));
