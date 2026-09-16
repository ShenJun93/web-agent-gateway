import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const workflowPath = join(process.cwd(), '.github', 'workflows', 'native-host-distribution.yml');
const mainPushCondition = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const expectedPushPaths = [
  '.github/workflows/native-host-distribution.yml',
  'browser/native-host/**',
  'src/browser-adapter/**',
  'scripts/build-native-host.ts',
  'scripts/package-native-host-distribution.ts',
  'scripts/verify-native-host-distribution.ts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
] as const;

async function workflowText(): Promise<string> {
  return readFile(workflowPath, 'utf8');
}

test('native host workflow has narrow triggers permissions runner and immutable actions', async () => {
  const workflow = await workflowText();
  assert.match(workflow, /pull_request:\s*\n\s*branches:\s*\[main\]/);
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /runs-on:\s*windows-2025/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /node-version:\s*['"]24\.20\.0['"]/);
  assert.match(workflow, /package-manager-cache:\s*false/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
});

test('native host main push matches exact publication inputs while PR validation stays unfiltered', async () => {
  const workflow = (await workflowText()).replace(/\r\n/g, '\n');
  assert.match(workflow, /pull_request:\n    branches: \[main\]\n  push:/);
  const expectedPushTrigger = [
    '  push:',
    '    branches: [main]',
    '    paths:',
    ...expectedPushPaths.map((path) => `      - '${path}'`),
  ].join('\n');
  assert.ok(
    workflow.includes(`${expectedPushTrigger}\n\npermissions:`),
    'push trigger must use the exact native-host publication input allowlist',
  );
});

test('native host workflow pins researched action commits and forbids floating tags', async () => {
  const workflow = await workflowText();
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.doesNotMatch(workflow, /uses:\s+[^@\s]+@v\d+(?:\.\d+){0,2}\s*$/m);
});

test('native host publication is main-push only and disambiguates rerun attempts', async () => {
  const workflow = await workflowText();
  const conditionMatches = workflow.match(new RegExp(`if: \\${mainPushCondition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')) ?? [];
  assert.equal(conditionMatches.length, 3);
  assert.match(workflow, /name:\s*wag-native-host-windows-x64-\$\{\{\s*github\.sha\s*\}\}-attempt-\$\{\{\s*github\.run_attempt\s*\}\}/);
  assert.match(workflow, /if-no-files-found:\s*error/);
  assert.match(workflow, /retention-days:\s*14/);
});
