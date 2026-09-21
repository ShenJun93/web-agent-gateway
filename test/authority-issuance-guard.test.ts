/**
 * The authority-issuance guard patch: what it refuses, what it must not refuse, and whether it is
 * installed yet.
 *
 * ## The gap
 *
 * `.claude/rules/human-presence-boundary.md` states, twice and in the same words, that issuing a
 * Goal Lease or a Goal UI Delegation is human-only and out of band and that Claude may use a grant
 * but never create one. Until this patch that was the only rule in the file with **no pattern
 * behind it anywhere** — not in the hook, not in the deny list. It was a rule kept by Claude
 * choosing to keep it, which is exactly the class of claim this project has spent four reviews
 * learning not to make.
 *
 * Claude cannot close it either: `.claude/settings.json` denies Claude's writes under `.claude/`,
 * and proposing the patch is as far as Claude may legitimately go. So the patch sits in
 * `docs/pending/` and a human applies it.
 *
 * ## Why these tests are not skipped while it is pending
 *
 * A suite that quietly skipped until someone applied a patch would be the same defect wearing
 * different clothes — confident prose over a mechanism nothing reaches. So instead:
 *
 *   - the **behaviour** tests load the applier's own replacement table, apply it in memory to the
 *     live guard, and *execute* the result. They run now, they run after application, and they
 *     cannot drift from what a human would install, because they are built from it.
 *   - the **installation** test asserts the live guard is in exactly one of two known states and
 *     says which. There is no third outcome, and no branch that asserts nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const applierUrl = new URL('../docs/pending/apply-authority-issuance-guard.mjs', import.meta.url);
const applier = (await import(applierUrl.href)) as {
  GUARD_PATH: string;
  EXPECTED_BEFORE: string;
  EXPECTED_AFTER: string;
  applyReplacements(source: string): string;
  REPLACEMENTS: ReadonlyArray<{ name: string; from: string; to: string }>;
};

type Verdict = { deny: false } | { deny: true; reason: string };
type Decide = (event: unknown) => Verdict;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const liveSource = await readFile(applier.GUARD_PATH, 'utf8');
const liveDigest = sha256(liveSource);
const applied = liveDigest === applier.EXPECTED_AFTER;

/**
 * The patched guard, loaded and executable.
 *
 * Written to a scratch file and imported, because a hook is a module and the property under test is
 * what it *decides* — not what its source contains. Reading it as text is how the previous
 * extension tests missed a missing call that looked exactly like the code around it.
 */
const patchedDecide: Decide = await (async () => {
  const source = applied ? liveSource : applier.applyReplacements(liveSource);
  const directory = await mkdtemp(join(tmpdir(), 'wag-issuance-guard-'));
  const file = join(directory, 'patched-guard.mjs');
  await writeFile(file, source, 'utf8');
  // `pathToFileURL`, because a bare Windows path is an unsupported ESM URL scheme.
  const module = (await import(pathToFileURL(file).href)) as { decide: Decide };
  return module.decide;
})();

const call = (tool_name: string, tool_input: unknown): Verdict =>
  patchedDecide({ tool_name, tool_input });

const bash = (command: string): Verdict => call('Bash', { command });

const denied = (verdict: Verdict, what: string): string => {
  assert.equal(verdict.deny, true, `${what} must be refused`);
  return (verdict as { deny: true; reason: string }).reason;
};

const allowed = (verdict: Verdict, what: string): void => {
  assert.equal(verdict.deny, false, `${what} must NOT be refused: ${JSON.stringify(verdict)}`);
};

// -------------------------------------------------------------------------------------------
// Running issuance
// -------------------------------------------------------------------------------------------

test('the delegation control CLI is refused when it issues or renews', () => {
  const reason = denied(
    bash('npx tsx scripts/delegation-control.ts --issue --goal goal_x --session session_y '
      + '--workspace ws_1 --tools repo.search --origin https://chatgpt.com --ttl-minutes 60'),
    'issuing a delegation',
  );
  assert.match(reason, /issues or renews a Goal UI Delegation/);
  assert.match(reason, /human-presence-boundary\.md/, 'the refusal names the rule it enforces');

  denied(
    bash('npx tsx scripts/delegation-control.ts --renew uidel_abc --ttl-minutes 60'),
    'renewing a delegation',
  );
  denied(bash('node scripts/delegation-control.ts --issue'), 'issuing via node');
  denied(
    bash('npm exec -- tsx scripts/delegation-control.ts --issue --goal g'),
    'issuing through npm exec',
  );
});

test('a one-liner that calls issuance directly is refused, on either shell', () => {
  denied(
    bash('npx tsx -e "store.insertUiDelegation({ delegationId: 1 })"'),
    'inserting a delegation row from a one-liner',
  );
  denied(
    bash('node -e "s.insertGoalLease({})"'),
    'inserting a lease row from a one-liner',
  );
  denied(
    bash('npx tsx -e "const p = new UiDelegationControlPlane({ store, key })"'),
    'constructing the control plane from a one-liner',
  );
  denied(
    call('PowerShell', { command: 'npx tsx -e "store.renewUiDelegation({})"' }),
    'renewing from PowerShell',
  );
});

// -------------------------------------------------------------------------------------------
// Naming a grant in configuration, which is the act that makes a row live
// -------------------------------------------------------------------------------------------

test('writing a grant id into a JSON configuration is refused', () => {
  const reason = denied(
    call('Write', {
      file_path: 'E:/config/wag-private.json',
      content: JSON.stringify({
        repositoryEngineering: { mutation: { goalUiDelegationId: 'uidel_abc123' } },
      }),
    }),
    'naming a delegation in config',
  );
  assert.match(reason, /names a Goal Lease or a Goal UI Delegation in a configuration file/);
  assert.match(reason, /inert/, 'the refusal explains why naming is the consequential act');

  denied(
    call('Edit', {
      file_path: 'C:\\Users\\x\\wag.json',
      old_string: '{}',
      new_string: '{ "goalLeaseId": "lease_abc" }',
    }),
    'naming a lease in config, with Windows separators',
  );
});

// -------------------------------------------------------------------------------------------
// What it must not refuse. Each of these is a thing a person may need in a hurry.
// -------------------------------------------------------------------------------------------

test('revocation and the local stop are never refused', () => {
  allowed(bash('npx tsx scripts/delegation-control.ts --revoke uidel_abc'), 'revoking a delegation');
  allowed(bash('npm run lease:stop'), 'engaging the kill switch');
  allowed(
    bash('npx tsx scripts/lease-stop.ts'),
    'engaging the kill switch by path',
  );
});

test('read-only inspection of the issuance surfaces is never refused', () => {
  allowed(bash('npx tsx scripts/delegation-control.ts --sessions'), 'listing sessions');
  allowed(bash('npx tsx scripts/delegation-control.ts --workspaces'), 'listing workspaces');
  allowed(bash('npx tsx scripts/delegation-control.ts --show uidel_abc'), 'showing a delegation');
  allowed(bash('npx tsx scripts/delegation-control.ts --help'), 'reading the usage');
});

test('reading and analysing issuance is not performing it', () => {
  allowed(bash('cat scripts/delegation-control.ts'), 'reading the control script');
  allowed(bash('grep -n "insertUiDelegation" src/durable-store.ts'), 'grepping for the symbol');
  allowed(bash('rg -- --issue scripts/delegation-control.ts'), 'grepping for the flag');
  allowed(
    bash('git commit -F docs/benchmarks/notes.md'),
    'committing a document that discusses issuance',
  );
});

test('the ordinary gates still run', () => {
  for (const command of [
    'npm test',
    'npm run typecheck',
    'npm run build',
    'npx tsc -p tsconfig.json --noEmit',
    'npx tsx --test test/goal-ui-delegation-planes.test.ts',
    'npx tsx --test --test-concurrency=1 test/goal-lease-delegation-composition.test.ts',
    'npm run test:delegation-e2e',
    'npm run test:goal-lease',
    'npx tsx scripts/verify-delegation-native-host.ts',
    'npx tsx scripts/verify-delegation-rule-patch.ts',
    'npm run build:delegation-native-host',
  ]) {
    allowed(bash(command), command);
  }
});

test('writing an ordinary source or test file is not refused', () => {
  allowed(
    call('Write', {
      file_path: 'test/goal-ui-delegation-planes.test.ts',
      content: 'const control = new UiDelegationControlPlane({ store, key });',
    }),
    'a fixture that issues into a temporary store',
  );
  allowed(
    call('Write', {
      file_path: 'src/durable-store.ts',
      content: '  insertUiDelegation(record) { /* ... */ }',
    }),
    'the file that implements the insert',
  );
  allowed(
    call('Write', {
      file_path: 'docs/adr/0029-goal-ui-delegation-v1.md',
      content: 'Issuance is human-only: goalUiDelegationId must be set by a person.',
    }),
    'documentation that names the config field',
  );
  allowed(
    call('Write', { file_path: 'package.json', content: '{ "name": "web-agent-gateway" }' }),
    'an ordinary JSON file that names no grant',
  );
});

// -------------------------------------------------------------------------------------------
// Everything the earlier guard refused, it still refuses
// -------------------------------------------------------------------------------------------

test('the patch is additive by construction, so nothing existing can have been deleted', () => {
  // Each replacement must *contain* the text it replaces. That is a mechanical proof that no
  // existing branch, pattern or refusal was dropped — stronger than re-asserting a sample of the
  // old behaviour, and it holds for the cases nobody thought to re-assert.
  for (const { name, from, to } of applier.REPLACEMENTS) {
    assert.ok(
      to.includes(from),
      `replacement "${name}" does not preserve the text it replaces, so it is not purely additive`,
    );
    assert.equal(liveSource.split(from).length - 1, 1, `anchor "${name}" must occur exactly once`);
  }

  const patched = applied ? liveSource : applier.applyReplacements(liveSource);
  assert.ok(patched.length > liveSource.length || applied, 'the patch adds text');
  for (const kept of [
    'COMPUTER_USE_ALLOWED', 'BROWSER_READ_ONLY', 'OPERATOR_URL_FILE', 'BROWSER_DRIVER',
    'isProtectedTarget', 'matchOperatorSurface', 'matchRunSurface', 'WAG_STATE_FILE',
  ]) {
    assert.ok(patched.includes(kept), `${kept} must survive the patch`);
  }
});

test('the patch adds refusals and removes none', () => {
  denied(call('mcp__computer-use__left_click', { coordinate: [10, 10] }), 'a screen click');
  denied(
    call('mcp__Claude_Browser__computer', {
      action: 'left_click', url: 'chrome-extension://abc/sidepanel.html',
    }),
    'a browser call at the Run surface',
  );
  denied(
    call('Write', { file_path: '.claude/hooks/wag-human-gate-guard.mjs', content: 'x' }),
    'rewriting the guard itself',
  );
  denied(
    bash('cat E:/state/browser-operator-v4.sqlite.operator-url'),
    'reading the operator credential',
  );
  denied(
    bash('curl http://127.0.0.1:7788/mutations/mut_1/approve'),
    'approving over HTTP',
  );
  denied(
    bash('playwright-cli click --selector "#run" chrome-extension://abc/sidepanel.html'),
    'driving a browser at the Run surface',
  );
  allowed(bash('npm run operator:open'), 'the sanctioned operator helper');
});

// -------------------------------------------------------------------------------------------
// The residuals, asserted so a later reader cannot mistake them for coverage
// -------------------------------------------------------------------------------------------

test('what this patch does not close, measured rather than described', () => {
  // 1. A text match cannot see through indirection. A script written first and run second reaches
  //    issuance with a command line that names none of these patterns. The guard is a tripwire,
  //    not a sandbox, and `human-presence-boundary.md` already says a shell is a same-user escape
  //    hatch that ADR-0019 puts outside the containment claim.
  allowed(
    bash('npx tsx scripts/some-helper.ts'),
    'a script whose *contents* issue a delegation is not visible in the command text',
  );

  // 2. String obfuscation evades it, exactly as it evades every other pattern in this file.
  allowed(
    bash('npx tsx -e "s[\'insert\' + \'GoalLease\']({})"'),
    'a split symbol is not matched, which is a property of text matching and is stated, not fixed',
  );

  // 3. A wrapper npm script would hide the CLI name. None exists today; if one is added, its name
  //    belongs in GRANT_CLI.
  allowed(
    bash('npm run issue-delegation'),
    'no such script exists; adding one would need its name added to the pattern',
  );

  // 4. Naming a grant in a non-JSON config. The supported config is JSON, and widening this to all
  //    file types refused documentation and source alike — the over-match this project has already
  //    paid for once.
  allowed(
    call('Write', { file_path: 'E:/config/wag.yaml', content: 'goalUiDelegationId: uidel_abc' }),
    'a YAML config is not the supported shape and is not matched',
  );

  // What none of these buy: any of them still has to get past WAG itself. A delegation authorises
  // a Run and never an effect, an effect still needs the operator or a lease that names the goal,
  // and `npm run lease:stop` refuses every admission in every process without their cooperation.
});

// -------------------------------------------------------------------------------------------
// Installation state: exactly two outcomes, both asserted
// -------------------------------------------------------------------------------------------

test('the live guard is either the committed one or the patched one, and nothing else', () => {
  assert.ok(
    liveDigest === applier.EXPECTED_BEFORE || liveDigest === applier.EXPECTED_AFTER,
    `the live guard hashes to ${liveDigest}, which is neither the documented before `
    + `(${applier.EXPECTED_BEFORE}) nor the documented after (${applier.EXPECTED_AFTER}). `
    + 'Someone edited it outside this patch; review the difference.',
  );
});

test('the live guard refuses issuance once applied, and demonstrably does not before', async () => {
  const live = (await import(pathToFileURL(applier.GUARD_PATH).href)) as { decide: Decide };
  const issuing = live.decide({
    tool_name: 'Bash',
    tool_input: { command: 'npx tsx scripts/delegation-control.ts --issue --goal g' },
  });

  if (applied) {
    assert.equal(issuing.deny, true, 'the patch is applied, so the live guard must refuse issuance');
    return;
  }
  // Not applied. This asserts the *measured* state of the gap rather than skipping: the live guard
  // lets issuance through today, which is precisely why the patch exists. When a human applies it
  // this branch stops running and the branch above takes over — neither is a no-op.
  assert.equal(
    issuing.deny, false,
    'the patch is not applied, so the gap must still be open here; if this now denies, the guard '
    + 'was changed by something other than the pending patch and the digests above are stale',
  );
});
