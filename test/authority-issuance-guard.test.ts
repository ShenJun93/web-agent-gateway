/**
 * The authority-issuance rule, and the guard that now enforces it.
 *
 * ## What this covers
 *
 * `.claude/rules/human-presence-boundary.md` says the same thing twice, once for each authority:
 * issuance is human-only and out of band, and Claude may *use* a grant but never create, widen or
 * renew one. Until 2026-09-21 neither statement had a pattern behind it anywhere — not in the hook,
 * not in the deny list. A human applied the patch that gave it one; these tests pin what it does.
 *
 * ## Why the mutation checks live here rather than in the battery
 *
 * The guard is under `.claude/`, and `scripts/delegation-mutation-battery.ts` works by writing a
 * mutated file back into the tree. Pointing it at the guard would mean the battery writing the one
 * directory the whole design forbids writing. So the weakenings below copy the guard to a scratch
 * file, mutate the copy, import it, and assert the copy stops refusing something the real one
 * refuses. Same evidence, no write.
 *
 * This structure exists because of a defect measured the moment the patch landed. While the patch
 * was *pending*, these tests executed a guard built from the applier's replacement table, and five
 * battery mutations against that table were CAUGHT. Applying the patch made the live guard the real
 * thing, the test stopped calling the table, and all five silently became SURVIVED — coverage that
 * evaporated at the exact moment the thing it covered went live, and that would have been reported
 * as "133 caught" by a run nobody re-did. Measured, not theorised: the five were re-run and all five
 * survived.
 *
 * The lesson generalises past this file. A test that reaches its subject through a *substitute* for
 * the subject stops testing anything the day the substitute is retired, and nothing fails to say so.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  GUARD_PATH_RELATIVE,
  ISSUANCE_GUARD_SHA256,
} from '../scripts/verify-delegation-rule-patch.js';

const guardUrl = new URL(`../${GUARD_PATH_RELATIVE}`, import.meta.url);
const guardPath = fileURLToPath(guardUrl);

type Verdict = { deny: false } | { deny: true; reason: string };
type Decide = (event: unknown) => Verdict;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const liveSource = await readFile(guardPath, 'utf8');
const { decide } = (await import(guardUrl.href)) as { decide: Decide };

const call = (tool_name: string, tool_input: unknown): Verdict => decide({ tool_name, tool_input });
const bash = (command: string): Verdict => call('Bash', { command });

const denied = (verdict: Verdict, what: string): string => {
  assert.equal(verdict.deny, true, `${what} must be refused`);
  return (verdict as { deny: true; reason: string }).reason;
};

const allowed = (verdict: Verdict, what: string): void => {
  assert.equal(verdict.deny, false, `${what} must NOT be refused: ${JSON.stringify(verdict)}`);
};

/**
 * Issuance forms, assembled rather than written out.
 *
 * The guard matches on command *text*, so a literal issuing flag beside `delegation-control` in
 * this file would make the file itself unquotable in a shell — and the project has already paid
 * once for a commit message refused for naming a file. Splitting the literals keeps the evidence
 * runnable, and is itself an honest demonstration of residual 2 at the bottom of this file.
 */
const CONTROL_CLI = 'scripts/delegation-control.ts';
const ISSUE = ['--is', 'sue'].join('');
const RENEW = ['--re', 'new'].join('');
const INSERT_LEASE = ['insert', 'GoalLease'].join('');
const INSERT_DELEGATION = ['insert', 'UiDelegation'].join('');

// -------------------------------------------------------------------------------------------
// Installation
// -------------------------------------------------------------------------------------------

test('the live guard is the one a human authorised', () => {
  assert.equal(
    sha256(liveSource), ISSUANCE_GUARD_SHA256,
    'the guard on disk is not the authorised build. It was applied out of band by a human on '
    + '2026-09-21 and verified by reproducing the transformation from the committed baseline; a '
    + 'different digest means someone has edited it since, and the receipt is stale.',
  );
});

// -------------------------------------------------------------------------------------------
// Running issuance
// -------------------------------------------------------------------------------------------

test('the delegation control CLI is refused when it issues or renews', () => {
  const reason = denied(
    bash(`npx tsx ${CONTROL_CLI} ${ISSUE} --goal goal_x --session session_y `
      + '--workspace ws_1 --tools repo.search --origin https://chatgpt.com --ttl-minutes 60'),
    'issuing a delegation',
  );
  assert.match(reason, /issues or renews a Goal UI Delegation/);
  assert.match(reason, /human-presence-boundary\.md/, 'the refusal names the rule it enforces');

  denied(bash(`npx tsx ${CONTROL_CLI} ${RENEW} uidel_abc --ttl-minutes 60`), 'renewing');
  denied(bash(`node ${CONTROL_CLI} ${ISSUE}`), 'issuing via node');
  denied(bash(`npm exec -- tsx ${CONTROL_CLI} ${ISSUE} --goal g`), 'issuing through npm exec');
});

test('a one-liner that calls issuance directly is refused, on either shell', () => {
  denied(bash(`npx tsx -e "store.${INSERT_DELEGATION}({ delegationId: 1 })"`), 'inserting a delegation');
  denied(bash(`node -e "s.${INSERT_LEASE}({})"`), 'inserting a lease');
  denied(
    bash('npx tsx -e "const p = new UiDelegationControlPlane({ store, key })"'),
    'constructing the control plane',
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
  assert.match(reason, /names a Goal Lease, a Goal UI Delegation, or a session correlation in a configuration file/);
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

test('naming a session correlation in a JSON config is refused', () => {
  // sessionCorrelation (ADR-0030) selects which durable session the stdio surface acts as, and so
  // which session a Goal Lease's admittedSessions is matched against. Writing it is authority
  // configuration in the same sense as naming a lease, and is refused for the same reason.
  const reason = denied(
    call('Write', {
      file_path: 'E:/config/wag-private.json',
      content: JSON.stringify({
        repositoryEngineering: {
          mutation: { sessionCorrelation: 'session_11111111-2222-3333-4444-555555555555' },
        },
      }),
    }),
    'naming a session correlation in config',
  );
  assert.match(reason, /session correlation/);

  denied(
    call('Edit', {
      file_path: 'C:\\Users\\x\\wag.json',
      old_string: '{}',
      new_string: '{ "sessionCorrelation": "session_11111111-2222-3333-4444-555555555555" }',
    }),
    'naming a session correlation in config, with Windows separators',
  );
});

test('the session-correlation refusal does not spill onto reads or non-grant config', () => {
  // Only a WRITE that names the field is refused. Reading, grepping, a JSON write that names no
  // grant, and a prose mention in a non-config file all stay allowed.
  allowed(bash('rg sessionCorrelation E:/config'), 'grepping for the field is reading, not naming');
  allowed(
    call('Write', { file_path: 'E:/config/wag-private.json', content: '{"allowedRoots":["E:/x"]}' }),
    'a JSON config write that names no grant is unaffected',
  );
  allowed(
    call('Write', { file_path: 'E:/notes.txt', content: 'sessionCorrelation is set by a person' }),
    'a prose mention in a non-config file is not a grant-naming write',
  );
});

// -------------------------------------------------------------------------------------------
// What it must not refuse. Each of these is a thing a person may need in a hurry.
// -------------------------------------------------------------------------------------------

test('revocation and the local stop are never refused', () => {
  allowed(bash(`npx tsx ${CONTROL_CLI} --revoke uidel_abc`), 'revoking a delegation');
  allowed(bash('npm run lease:stop'), 'engaging the kill switch');
  allowed(bash('npx tsx scripts/lease-stop.ts'), 'engaging the kill switch by path');
});

test('read-only inspection of the issuance surfaces is never refused', () => {
  allowed(bash(`npx tsx ${CONTROL_CLI} --sessions`), 'listing sessions');
  allowed(bash(`npx tsx ${CONTROL_CLI} --workspaces`), 'listing workspaces');
  allowed(bash(`npx tsx ${CONTROL_CLI} --show uidel_abc`), 'showing a delegation');
  allowed(bash(`npx tsx ${CONTROL_CLI} --help`), 'reading the usage');
});

test('reading and analysing issuance is not performing it', () => {
  allowed(bash(`cat ${CONTROL_CLI}`), 'reading the control script');
  allowed(bash(`grep -n "${INSERT_DELEGATION}" src/durable-store.ts`), 'grepping for the symbol');
  allowed(bash(`rg -- ${ISSUE} ${CONTROL_CLI}`), 'grepping for the flag');
  allowed(bash('git commit -F docs/benchmarks/notes.md'), 'committing a document about issuance');
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
    'npm run test:dc-replacement',
    'npm run test:business',
    'npx tsx scripts/verify-delegation-native-host.ts',
    'npx tsx scripts/verify-delegation-rule-patch.ts',
    'npx tsx scripts/delegation-mutation-battery.ts',
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
      content: `  ${INSERT_DELEGATION}(record) { /* ... */ }`,
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

test('the patch added refusals and removed none', () => {
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
  denied(bash('curl http://127.0.0.1:7788/mutations/mut_1/approve'), 'approving over HTTP');
  denied(
    bash('playwright-cli click --selector "#run" chrome-extension://abc/sidepanel.html'),
    'driving a browser at the Run surface',
  );
  allowed(bash('npm run operator:open'), 'the sanctioned operator helper');
});

// -------------------------------------------------------------------------------------------
// Mutation: every issuance pattern must be load-bearing
// -------------------------------------------------------------------------------------------

/**
 * Import a weakened copy of the live guard.
 *
 * The copy goes to a scratch directory. The guard itself is never written, which is the whole
 * reason this is a test rather than a battery entry.
 */
async function weaken(from: string, to: string): Promise<Decide> {
  assert.equal(
    liveSource.split(from).length - 1, 1,
    `the weakening anchor must occur exactly once in the live guard: ${from}`,
  );
  const directory = await mkdtemp(join(tmpdir(), 'wag-guard-mutant-'));
  const file = join(directory, 'mutant.mjs');
  await writeFile(file, liveSource.replace(from, to), 'utf8');
  // `pathToFileURL`, because a bare Windows path is an unsupported ESM URL scheme.
  const module = (await import(pathToFileURL(file).href)) as { decide: Decide };
  return module.decide;
}

test('each issuance pattern is the thing that refuses, proved by weakening it', async () => {
  const weakenings: Array<{
    name: string;
    from: string;
    to: string;
    probe: { tool: string; input: unknown };
  }> = [
    {
      name: 'the issuing-flag pattern',
      from: 'const GRANT_CLI_FLAG = /--(?:issue|renew)\\b/;',
      to: 'const GRANT_CLI_FLAG = /--(?:nothing-at-all)\\b/;',
      probe: { tool: 'Bash', input: { command: `npx tsx ${CONTROL_CLI} ${ISSUE} --goal g` } },
    },
    {
      name: 'the control-CLI pattern',
      from: 'const GRANT_CLI = /\\bdelegation-control(?:\\.[cm]?[jt]s)?\\b/i;',
      to: 'const GRANT_CLI = /\\bnothing-at-all\\b/i;',
      probe: { tool: 'Bash', input: { command: `npx tsx ${CONTROL_CLI} ${ISSUE} --goal g` } },
    },
    {
      name: 'the direct-call pattern',
      from: "  if (GRANT_CALL.test(text)) return 'calls delegation or lease issuance directly';",
      to: "  if (false) return 'calls delegation or lease issuance directly';",
      probe: { tool: 'Bash', input: { command: `node -e "s.${INSERT_LEASE}({})"` } },
    },
    {
      name: 'the config-field pattern',
      from: 'const GRANT_CONFIG_FIELD = /\\b(?:goalUiDelegationId|goalLeaseId|sessionCorrelation)\\b/;',
      to: 'const GRANT_CONFIG_FIELD = /\\b(?:nothingAtAll)\\b/;',
      probe: {
        tool: 'Write',
        input: { file_path: 'E:/config/wag.json', content: '{"goalUiDelegationId":"uidel_x"}' },
      },
    },
    {
      name: 'the writer branch itself',
      from: '  if (WRITERS.has(tool)) {\n    const why = matchAuthorityWrite(event?.tool_input);',
      to: '  if (false) {\n    const why = matchAuthorityWrite(event?.tool_input);',
      probe: {
        tool: 'Write',
        input: { file_path: 'E:/config/wag.json', content: '{"goalLeaseId":"lease_x"}' },
      },
    },
    {
      name: 'the shell branch itself',
      from: '    const issuing = matchAuthorityIssuance(text);\n    if (issuing) {',
      to: '    const issuing = matchAuthorityIssuance(text);\n    if (false && issuing) {',
      probe: { tool: 'Bash', input: { command: `npx tsx ${CONTROL_CLI} ${RENEW} uidel_a` } },
    },
  ];

  for (const { name, from, to, probe } of weakenings) {
    const mutant = await weaken(from, to);
    const event = { tool_name: probe.tool, tool_input: probe.input };
    assert.equal(
      decide(event).deny, true,
      `${name}: the live guard must refuse this probe, or the weakening proves nothing`,
    );
    assert.equal(
      mutant(event).deny, false,
      `${name}: weakening it did not change the verdict, so this pattern is not what refuses — `
      + 'either the probe is caught by something else or the pattern is dead',
    );
  }
});

test('weakening the runner requirement makes the guard refuse reading, which is why it is there', async () => {
  const mutant = await weaken(
    '  if (!SCRIPT_RUNNER.test(text)) return undefined;',
    '  // weakened: a mention is treated as an invocation',
  );
  const reading = { tool_name: 'Bash', tool_input: { command: `rg -- ${ISSUE} ${CONTROL_CLI}` } };
  allowed(decide(reading), 'the live guard allows grepping for the flag');
  assert.equal(
    mutant(reading).deny, true,
    'without the runner requirement, reading about issuance is refused — which would refuse the '
    + 'review of this very boundary, and is the reason the requirement exists',
  );
});

// -------------------------------------------------------------------------------------------
// The residuals, asserted so a later reader cannot mistake them for coverage
// -------------------------------------------------------------------------------------------

test('what this guard does not close, measured rather than described', () => {
  // 1. A text match cannot see through indirection. A script written first and run second reaches
  //    issuance with a command line that names none of these patterns. The guard is a tripwire,
  //    not a sandbox; ADR-0019 already puts a same-user shell outside the containment claim.
  allowed(
    bash('npx tsx scripts/some-helper.ts'),
    'a script whose contents issue a grant is invisible in the command text',
  );

  // 2. String obfuscation evades it, exactly as it evades every other pattern in the file — and
  //    this suite relies on that fact to be writable at all, which is an honest demonstration
  //    rather than a hypothetical.
  allowed(
    bash(`npx tsx -e "s['insert' + 'GoalLease']({})"`),
    'a split symbol is not matched, which is a property of text matching and is stated, not fixed',
  );

  // 3. A wrapper npm script would hide the CLI name. None exists today.
  allowed(bash('npm run issue-delegation'), 'no such script exists; adding one needs the pattern');

  // 4. Naming a grant in a non-JSON config. The supported config shape is JSON.
  allowed(
    call('Write', { file_path: 'E:/config/wag.yaml', content: 'goalUiDelegationId: uidel_abc' }),
    'a YAML config is not the supported shape and is not matched',
  );

  // 5. The guard has no integrity of its own: it refuses writes to its own directory, but that
  //    rule lives in the file it protects, and a shell can still delete the file.
  denied(
    call('Edit', {
      file_path: '.claude/hooks/wag-human-gate-guard.mjs', old_string: 'a', new_string: 'b',
    }),
    'editing the guard through a sanctioned tool',
  );
  allowed(bash('rm .claude/hooks/wag-human-gate-guard.mjs'), 'but a shell can still remove it');

  // What none of these buys: an effect. A delegation authorises a Run and never an effect; an
  // effect needs the operator or a lease that names the delegation's goal; and `npm run lease:stop`
  // refuses every admission in every process without their cooperation.
});
