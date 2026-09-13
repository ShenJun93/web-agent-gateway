import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createNativeHostManifest } from '../src/browser-adapter/native-host-manifest.js';

const execFileAsync = promisify(execFile);

const extensionId = 'nnhhhppkpogkedpjnijeagcbfjaoogec';

test('native host manifest allowlists exactly one stable extension origin', () => {
  const executablePath = 'C:\\Program Files\\WebAgentGateway\\wag-native-host.exe';
  assert.deepEqual(createNativeHostManifest({ executablePath, extensionId }), {
    name: 'com.openai.web_agent_gateway',
    description: 'Web Agent Gateway browser adapter',
    path: executablePath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  });
});

test('native host manifest rejects unsafe v1 identity and path forms', () => {
  for (const executablePath of ['wag-native-host.exe', '/tmp/wag-native-host.exe']) {
    assert.throws(() => createNativeHostManifest({ executablePath, extensionId }), /Windows absolute/i);
  }
  for (const badId of ['*', 'abcdefghijklmnop', 'abcdefghijklmnopabcdefghijklmnopq']) {
    assert.throws(() => createNativeHostManifest({ executablePath: 'C:\\wag\\host.exe', extensionId: badId }), /extension id/i);
  }
});

test('native host manifest CLI writes JSON artifact only', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-native-manifest-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const output = join(temp, 'manifest.json');
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const executablePath = 'C:\\Program Files\\WebAgentGateway\\wag-native-host.exe';
  await execFileAsync(process.execPath, [
    tsxCli, 'scripts/generate-native-host-manifest.ts',
    '--output', output,
    '--executable', executablePath,
    '--extension-id', extensionId,
  ], { cwd: process.cwd() });

  const manifest = JSON.parse(await readFile(output, 'utf8')) as { path?: string; allowed_origins?: string[] };
  assert.equal(manifest.path, executablePath);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
});
