import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { detectRuntimeIdentity } from '../src/runtime-identity.js';

test('runtime identity reports promoted source metadata without shell fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-runtime-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist'));
  const cli = join(root, 'dist', 'cli.js');
  await writeFile(cli, '// fixture\n', 'utf8');
  await writeFile(join(root, 'RUNTIME.json'), JSON.stringify({
    sourceHead: '1234567890abcdef1234567890abcdef12345678',
    capability: 'autonomous-local-runtime-v1',
  }), 'utf8');

  assert.deepEqual(detectRuntimeIdentity(cli, 1234, 567), {
    pid: 1234,
    parent_pid: 567,
    cli_path: cli,
    runtime_root: root,
    source_head: '1234567890abcdef1234567890abcdef12345678',
    capability: 'autonomous-local-runtime-v1',
    deployed: true,
  });
});

test('runtime identity is fail-open for source execution and malformed markers', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'wag-runtime-source-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  await mkdir(join(source, 'dist'));
  const cli = join(source, 'dist', 'cli.js');
  await writeFile(cli, '// fixture\n', 'utf8');

  assert.equal(detectRuntimeIdentity(cli, 1, 0).deployed, false);

  await writeFile(join(source, 'RUNTIME.json'), '{bad-json', 'utf8');
  const malformed = detectRuntimeIdentity(cli, 2, 1);
  assert.equal(malformed.deployed, true);
  assert.equal(malformed.runtime_root, source);
  assert.equal(malformed.source_head, undefined);
});
