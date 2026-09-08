import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { cases } from './cases.mjs';
const out = resolve('.local-runs/dsh-led/pilot-01');
await mkdir(out, { recursive: true });
const freeze = { version: 1, createdAt: new Date().toISOString(), selection: 'Three small engineering tasks for technical screening, not representative of general development.', arms: ['astra', 'dsh-alone', 'dsh-advisor'], cases: {} };
for (const [id, data] of Object.entries(cases)) {
  const base = join(out, id); await mkdir(base, { recursive: true });
  await writeFile(join(base, 'acceptance.mjs'), data.acceptance, { flag: 'wx' });
  freeze.cases[id] = { origin: data.origin, task: data.task, taskSha256: createHash('sha256').update(data.task).digest('hex'), acceptanceSha256: createHash('sha256').update(data.acceptance).digest('hex'), sourceHashes: {} };
  for (const [file, source] of Object.entries(data.files)) freeze.cases[id].sourceHashes[file] = createHash('sha256').update(source).digest('hex');
  for (const arm of freeze.arms) {
    const cwd = join(base, arm, 'work'); await mkdir(cwd, { recursive: true });
    for (const [file, source] of Object.entries({ ...data.files, 'visible.test.mjs': data.visible, 'package.json': '{"type":"module","private":true}' })) await writeFile(join(cwd, file), source, { flag: 'wx' });
    await writeFile(join(base, arm, 'spec.json'), JSON.stringify({ cwd, task: data.task, outputDir: join(base, arm, 'capture'), advisor: arm === 'dsh-advisor' }, null, 2), { flag: 'wx' });
  }
}
await writeFile(join(out, 'freeze.json'), JSON.stringify(freeze, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output: out, cases: Object.keys(cases), attempts: 9 }));
