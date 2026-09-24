import assert from 'node:assert/strict';
import test from 'node:test';

const guardUrl = new URL('../.claude/hooks/wag-human-gate-guard.mjs', import.meta.url);
type Verdict = { deny: false } | { deny: true; reason: string };
type Decide = (event: unknown) => Verdict;
const { decide } = (await import(guardUrl.href)) as { decide: Decide };

const call = (tool_name: string, tool_input: unknown): Verdict => decide({ tool_name, tool_input });
const bash = (command: string): Verdict => call('Bash', { command });
const denied = (verdict: Verdict, label: string): string => {
  assert.equal(verdict.deny, true, label + ' must be denied');
  return (verdict as { deny: true; reason: string }).reason;
};
const allowed = (verdict: Verdict, label: string): void => {
  assert.equal(verdict.deny, false, label + ' must be allowed');
};

const CONTROL = 'scripts/delegation-control.ts';
const ISSUE = ['--is', 'sue'].join('');
const RENEW = ['--re', 'new'].join('');
const INSERT = ['insert', 'UiDelegation'].join('');

test('Goal UI Delegation issue and renew remain human-only', () => {
  for (const command of [
    `npx tsx ${CONTROL} ${ISSUE} --goal goal_x --session session_x --workspace ws_x --confirm`,
    `npx tsx ${CONTROL} ${RENEW} uidel_x --confirm`,
  ]) {
    const reason = denied(bash(command), command);
    assert.match(reason, /Goal UI Delegation|human-only/i);
  }
});

test('direct delegation issuance calls are refused', () => {
  denied(
    bash(`npx tsx -e "store.${INSERT}({ delegationId: 'x' })"`),
    'direct durable-store delegation insert',
  );
  denied(
    bash('npx tsx -e "new UiDelegationControlPlane({})"'),
    'direct control-plane construction from an automated shell',
  );
});

test('naming browser delegation authority in JSON config is refused', () => {
  const reason = denied(
    call('Write', {
      file_path: 'E:/config/wag-private.json',
      content: JSON.stringify({
        repositoryEngineering: { mutation: { goalUiDelegationId: 'uidel_abc123' } },
      }),
    }),
    'browser delegation activation write',
  );
  assert.match(reason, /Goal UI Delegation/);
});

test('private-local stable identity is not an authority write', () => {
  allowed(
    call('Write', {
      file_path: 'E:/config/wag-private.json',
      content: JSON.stringify({
        repositoryEngineering: {
          mutation: { sessionCorrelation: 'session_11111111-2222-3333-4444-555555555555' },
        },
      }),
    }),
    'stable private-local identity',
  );
});

test('private-local automation and emergency stop are not blocked by the human gate', () => {
  allowed(bash('npm run autonomy:stop'), 'engaging the autonomous stop');
  allowed(bash('npx tsx scripts/autonomy-stop.ts --status'), 'reading autonomous stop status');
  allowed(bash(`npx tsx ${CONTROL} --revoke uidel_abc`), 'revoking a browser delegation');
  allowed(bash(`npx tsx ${CONTROL} --show uidel_abc`), 'inspecting a browser delegation');
  allowed(bash(`npx tsx ${CONTROL} --sessions`), 'listing browser sessions');
  allowed(bash(`npx tsx ${CONTROL} --workspaces`), 'listing browser workspaces');
});

test('reading and analysing the delegation boundary is not performing issuance', () => {
  allowed(bash(`cat ${CONTROL}`), 'reading the control script');
  allowed(bash('rg goalUiDelegationId src test scripts'), 'searching source');
  allowed(bash('npm test'), 'ordinary verification');
  allowed(bash('npm run build'), 'ordinary build');
});

test('the guard refuses edits to itself', () => {
  const reason = denied(
    call('Edit', {
      file_path: 'E:/Projects/web-agent-gateway/.claude/hooks/wag-human-gate-guard.mjs',
      old_string: 'x',
      new_string: 'y',
    }),
    'self-modification of the guard',
  );
  assert.match(reason, /writes the hook/i);
});

test('operator credentials remain unavailable to automation', () => {
  denied(
    call('Read', { file_path: 'E:/state/browser-operator-v4.sqlite.operator-url' }),
    'reading the operator bootstrap file',
  );
  denied(
    bash('Get-Content E:/state/browser-operator-v4.sqlite.operator-url'),
    'shell-reading the operator bootstrap file',
  );
});

test('browser Run cannot be driven by an automated browser command', () => {
  denied(
    bash('playwright-cli open chrome-extension://abcdef/sidepanel.html'),
    'driving the side panel',
  );
  allowed(
    bash('rg panel.execute browser/extension/service-worker.js'),
    'reading Run implementation source',
  );
});
