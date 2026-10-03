import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runner = readFileSync(join(root, 'scripts', 'wag-local-clean-install-acceptance.ps1'), 'utf8');
const fixture = readFileSync(join(root, 'scripts', 'wag-local-m15-clean-install-fixture.ps1'), 'utf8');
const setup = readFileSync(join(root, 'scripts', 'wag-local-setup.ps1'), 'utf8');
const promote = readFileSync(join(root, 'scripts', 'promote-autonomous-runtime.ts'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  files?: string[];
  scripts?: Record<string, string>;
};

test('clean-install acceptance runner is explicit-stage and never accepts a raw runtime secret CLI parameter', () => {
  assert.match(runner, /ValidateSet\('Baseline','Install','ConnectorProof','PostReboot','PostRebootProof'\)/);
  assert.match(runner, /wag-local-provision\.ps1/);
  assert.match(runner, /RuntimeKeyRef/);
  assert.doesNotMatch(runner, /\[string\]\$(?:ApiKey|AdminKey|Secret|Token)\b/i);
  assert.match(runner, /\$args \+= @\('-RuntimeKeyRef',\$RuntimeKeyRef\)/);
});

test('fresh baseline is fail-closed and fixture mode can never claim external acceptance', () => {
  assert.match(runner, /wagLocalAbsent/);
  assert.match(runner, /startupAbsent/);
  assert.match(runner, /tunnelProfileAbsent/);
  assert.match(runner, /devspacePortUnused/);
  assert.match(runner, /tunnelPortUnused/);
  assert.match(runner, /eligibleForExternalAcceptance = -not \$fixtureMode/);
  assert.match(runner, /FIXTURE_PASS_NOT_EXTERNAL_ACCEPTANCE/);
  assert.match(fixture, /WAG_CLEAN_ACCEPTANCE_FIXTURE = '1'/);
});

test('connector proof requires a WAG-read challenge and exact response before confirmation', () => {
  assert.match(runner, /WAG_ACCEPTANCE_CHALLENGE_V1:/);
  assert.match(runner, /WAG_ACCEPTANCE_RESPONSE_V1:/);
  assert.match(runner, /ACTION_REQUIRED_CONNECTOR_PROOF/);
  assert.match(runner, /-ConnectorConfirmed/);
  assert.match(runner, /Do not use shell or another connector/);
  assert.match(runner, /expectedResponseSha256/);
});

test('post-reboot acceptance requires a different boot identity, READY product health, and a second connector proof', () => {
  assert.match(runner, /baselineBootId/);
  assert.match(runner, /installBootId/);
  assert.match(runner, /rebootObserved = \[string\]\$bootId -ne \[string\]\$state\.installBootId/);
  assert.match(runner, /healthStatus -eq 'READY'/);
  assert.match(runner, /New-Challenge \$state 'post-reboot'/);
  assert.match(runner, /PostRebootProof/);
});

test('clean-install acceptance runner ships in npm packages, setup runtimes, and promotion runtimes', () => {
  assert.ok(packageJson.files?.includes('scripts/wag-local-clean-install-acceptance.ps1'));
  assert.match(packageJson.scripts?.['wag:clean-install-acceptance'] ?? '', /clean-install-acceptance --stage baseline/);
  assert.match(setup, /wag-local-clean-install-acceptance\.ps1/);
  assert.match(promote, /scripts\/wag-local-clean-install-acceptance\.ps1/);
});
