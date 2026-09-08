import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimWorkspace } from './workspace.mjs';
test('overlapping writers are refused and released ownership can be reused',async()=>{
  const stateDir=await mkdtemp(join(tmpdir(),'dsh-led-claim-'));
  try {
    const cwd=join(stateDir,'project');
    const release=await claimWorkspace({stateDir,cwd,taskId:'first',sessionId:'s1'});
    await assert.rejects(claimWorkspace({stateDir,cwd:join(cwd,'sub'),taskId:'second',sessionId:'s2'}),/Another task/);
    const sibling=await claimWorkspace({stateDir,cwd:join(stateDir,'other'),taskId:'other',sessionId:'s3'});
    await sibling(); await release();
    const again=await claimWorkspace({stateDir,cwd,taskId:'next',sessionId:'s4'});await again();
  } finally { await rm(stateDir,{recursive:true}); }
});
