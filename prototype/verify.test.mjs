import test from 'node:test';import assert from 'node:assert/strict';import {verifyCommand} from './verify.mjs';
test('verification preserves UTF-8 evidence and a failing exit',async()=>{
 const r=await verifyCommand([process.execPath,'-e',"process.stdout.write('中文证据');process.stderr.write('failed invariant');process.exitCode=1"],process.cwd());
 assert.equal(r.status,'failed');assert.equal(r.exitCode,1);assert.equal(r.stdout,'中文证据');assert.equal(r.stderr,'failed invariant');assert.equal(r.cleanupVerified,true);
});
test('verification timeout returns a failed outcome instead of hanging',async()=>{
 const started=Date.now();const r=await verifyCommand([process.execPath,'-e','setInterval(()=>{},1000)'],process.cwd(),100);
 assert.equal(r.timedOut,true);assert.equal(r.status,'failed');assert.ok(Date.now()-started<15000);
});
test('missing verifier is an infrastructure failure, not a failing assertion',async()=>{
 const r=await verifyCommand(['dsh-nonexistent-verifier-12345'],process.cwd());assert.equal(r.status,'failed');assert.equal(r.error,'ENOENT');assert.equal(r.exitCode,null);
});
