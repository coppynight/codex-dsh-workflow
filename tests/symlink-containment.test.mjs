import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { newFixtureDir, prepareBase, cleanupBase, serviceConfig, importService } from './fixtures.mjs';

// Canonicalize configured allowed roots with realpath before containment so
// symlinks/junctions cannot smuggle a cwd outside an allowed root, while
// links that resolve INTO an allowed root stay usable.
const base = newFixtureDir('containment');
const allowed = join(base, 'allowed');
const outside = join(base, 'outside');
const jroot = join(base, 'rootlink'); // configured root that is itself a junction
const subA = join(allowed, 'proj-a');
const escape = join(allowed, 'escape'); // junction inside the root that points outside
const aliasIn = join(base, 'alias-to-allowed'); // textual alias outside the root that lands inside

let linksOk = true;
let setupError = null;
try {
  await prepareBase(base, ['allowed/proj-a', 'allowed/proj-b', 'outside']);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(allowed, jroot, type);
  await symlink(outside, escape, type);
  await symlink(subA, aliasIn, type); // textual alias outside the root that lands inside it
} catch (error) {
  linksOk = false;
  setupError = error;
}

let service;
if (linksOk) {
  const config = serviceConfig(base, { roots: [allowed, jroot] });
  service = await importService(config);
} else {
  test('symlink/junction creation is unavailable in this sandbox', () => {
    assert.fail(`Cannot exercise symlink containment: ${setupError && setupError.message}`);
  });
}

test('cwd inside an allowed root is accepted', { skip: !linksOk }, async () => {
  const actual = await service.allowedCwd(subA);
  assert.equal(actual, await realpath(subA));
});

test('an allowed root that is itself a junction is canonicalized before containment', { skip: !linksOk }, async () => {
  const actual = await service.allowedCwd(join(jroot, 'proj-a'));
  assert.equal(actual, await realpath(subA));
});

test('an explicitly configured project root is itself a delegable cwd', { skip: !linksOk }, async () => {
  assert.equal(await service.allowedCwd(allowed), await realpath(allowed));
  assert.equal(await service.allowedCwd(jroot), await realpath(allowed));
});

test('a junction inside the root that escapes outside is rejected', { skip: !linksOk }, async () => {
  await assert.rejects(() => service.allowedCwd(escape), /below an allowed workspace root/);
});

test('a textual alias outside the root that resolves inside is accepted', { skip: !linksOk }, async () => {
  const actual = await service.allowedCwd(aliasIn);
  assert.equal(actual, await realpath(subA));
});

test('a plain directory outside every allowed root is rejected', { skip: !linksOk }, async () => {
  await assert.rejects(() => service.allowedCwd(outside), /below an allowed workspace root/);
});

test('nonexistent and relative cwds are rejected with guidance', { skip: !linksOk }, async () => {
  await assert.rejects(() => service.allowedCwd(join(base, 'missing')), /does not exist/);
  await assert.rejects(() => service.allowedCwd('proj-a'), /absolute/);
});

test.after(async () => {
  await cleanupBase(base);
});
