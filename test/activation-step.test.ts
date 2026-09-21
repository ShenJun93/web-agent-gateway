/**
 * The single human activation step, and the two things that keep it human.
 *
 * `docs/pending/activate-delegation-control.mjs` issues a Goal UI Delegation, names it in the live
 * config and issues a matching Goal Lease. It is the most consequential instrument in this
 * repository, so the property that matters is not only that it does the right thing when run — it
 * is that **Claude cannot run it**.
 *
 * Two layers, both asserted here rather than described:
 *
 *   1. the applied PreToolUse guard refuses the exact invocation, because the file name matches
 *      the issuance CLI pattern and the invocation carries an issuing flag;
 *   2. the script refuses a non-interactive stdin, so even a shell that got past the guard would
 *      have to be driven by a person at a terminal.
 *
 * The refusal paths are exercised by running the real script against a temporary store, because a
 * fail-closed instrument whose refusals have never fired is an instrument whose refusals are
 * prose. Nothing here issues anything: every case below is expected to exit non-zero having
 * written nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(
  new URL('../docs/pending/activate-delegation-control.mjs', import.meta.url),
);
const guardUrl = new URL('../.claude/hooks/wag-human-gate-guard.mjs', import.meta.url);
const { decide } = (await import(guardUrl.href)) as {
  decide: (event: unknown) => { deny: false } | { deny: true; reason: string };
};

const source = await readFile(SCRIPT, 'utf8');

// -------------------------------------------------------------------------------------------
// Layer 1 — the guard refuses Claude the exact invocation
// -------------------------------------------------------------------------------------------

test('the applied guard refuses Claude the activation command', () => {
  const invocation = `node docs/pending/activate-delegation-control.mjs ${['--is', 'sue'].join('')} `
    + '--session session_x --workspace ws_y --confirm';
  const verdict = decide({ tool_name: 'Bash', tool_input: { command: invocation } });
  assert.equal(
    verdict.deny, true,
    'the activation instrument must be unreachable from Claude at the tool layer. If this passes, '
    + 'the file name no longer matches the guard pattern and the second layer is carrying it alone.',
  );
  assert.match((verdict as { reason: string }).reason, /issues or renews a Goal UI Delegation/);
});

test('the file name is what the guard matches, so renaming it would break the refusal', () => {
  // Stated as an assertion because it is a non-obvious coupling: the protection comes from the
  // name matching `\bdelegation-control(\.[cm]?[jt]s)?\b`, not from anything inside the file.
  assert.match(SCRIPT.split('\\').join('/'), /\/activate-delegation-control\.mjs$/);
  const renamed = decide({
    tool_name: 'Bash',
    tool_input: { command: `node docs/pending/activate.mjs ${['--is', 'sue'].join('')}` },
  });
  assert.equal(
    renamed.deny, false,
    'a differently named script would NOT be refused by the guard — which is exactly why this one '
    + 'is named as it is, and why the interactive-stdin check exists as a second layer',
  );
});

// -------------------------------------------------------------------------------------------
// Layer 2 — the script itself refuses to run headless
// -------------------------------------------------------------------------------------------

/** Run the script with a pipe for stdin, which is what every automated caller has. */
async function run(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('it refuses a non-interactive stdin, which is what an automated caller has', async () => {
  const issue = ['--is', 'sue'].join('');
  const result = await run([issue, '--session', 'session_x', '--workspace', 'ws_y', '--confirm']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /stdin is not a terminal/);
  assert.match(result.stderr, /does not run headless/);
});

test('without the issuing and confirm flags it only prints usage and writes nothing', async () => {
  const result = await run([]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /usage: node docs\/pending\/activate-delegation-control\.mjs/);
  assert.match(result.stdout, /Refuses stale, ambiguous,/);
});

// -------------------------------------------------------------------------------------------
// The bounds it will apply, read from the instrument rather than restated
// -------------------------------------------------------------------------------------------

test('every bound it grants is strictly inside the ceiling the policy would allow', async () => {
  /**
   * Read a numeric constant from the instrument's source.
   *
   * Products of integer literals only — `120`, `64 * 1024` — parsed by splitting on `*` rather
   * than evaluated. A test that ran `eval` over a file to check that file's bounds would be a
   * worse idea than the bounds are good.
   */
  const number = (name: string): number => {
    const match = new RegExp(`const ${name} = ([0-9* ]+);`).exec(source);
    assert.ok(match, `${name} must be declared as a product of integer literals`);
    return match[1]!.split('*').reduce((total, part) => {
      const n = Number(part.trim());
      assert.ok(Number.isInteger(n), `${name} has a non-integer factor: ${part}`);
      return total * n;
    }, 1);
  };
  const { MAX_DELEGATION_WINDOW_MS } = await import('../src/goal-ui-delegation.js');
  const { MAX_LEASE_WINDOW_MS } = await import('../src/goal-lease.js');

  assert.ok(
    number('DELEGATION_TTL_MINUTES') * 60_000 < MAX_DELEGATION_WINDOW_MS,
    'the delegation it issues must be shorter than the 4h ceiling, not equal to it',
  );
  assert.ok(
    number('LEASE_TTL_MINUTES') * 60_000 < MAX_LEASE_WINDOW_MS,
    'the lease it issues must be shorter than the 12h ceiling',
  );
  assert.ok(number('MAX_ACTIONS') > 0 && number('MAX_ACTIONS') <= 8, 'the action budget stays small');
  assert.ok(number('LEASE_MAX_FILES') <= 4, 'the file budget stays small');
  assert.ok(number('SESSION_MAX_AGE_MINUTES') <= 120, 'a stale session is refused');
});

test('it names BOTH grants in configuration, in one atomic write', () => {
  // The first version named the delegation, issued the lease, then named the lease — and stopped
  // after the second step. The result was a live-looking lease row the runtime never loaded:
  // goalLeaseId absent means goalLease is undefined, no admission pass is created, and every
  // effect still needs the operator. It read as activated and was not.
  assert.ok(source.includes('goalUiDelegationId'), 'it writes the delegation id');
  assert.ok(source.includes('goalLeaseId'), 'it writes the lease id');
  assert.ok(
    source.includes('liveMutation.goalUiDelegationId !== delegationId')
    && source.includes('liveMutation.goalLeaseId !== leaseId'),
    'it reads the config back through the gateway loader and refuses unless BOTH are named',
  );
  assert.ok(
    source.includes('refusing to replace one that may be in force'),
    'it refuses to overwrite a lease that may already be in force',
  );
  // Two writes are two windows in which a crash names one grant and not the other. The atomic
  // rename collapses the outcomes to neither-or-both, so effect authority can never end up
  // broader than intended. The only direct CONFIG writes are the two rollback restores.
  assert.equal(
    source.split('await writeFile(CONFIG,').length - 1, 2,
    'the only direct CONFIG writes are the rollback restores',
  );
  assert.ok(source.includes('await rename(temporary, CONFIG)'), 'the naming write is atomic');
});

test('it binds one origin, one session, one adapter and one workspace — never a list', () => {
  for (const singular of [
    'allowedOrigins: [ORIGIN]',
    'admittedSessions: [sessionId]',
    'admittedAdapters: [ADAPTER]',
    'delegatedGoalIds: [goalId]',
    'workspaceRoots: [root]',
  ]) {
    assert.ok(source.includes(singular), `the instrument must bind exactly one: ${singular}`);
  }
  assert.ok(
    source.includes('workspaceId,') && source.includes('sessionId,'),
    'the delegation binds the exact workspace and session it was given',
  );
});

test('the lease tools are a subset of the delegated tools, so the lease cannot widen the run', () => {
  const list = (name: string): string[] => {
    const match = new RegExp(`const ${name} = (\\[[^\\]]*\\]);`).exec(source);
    assert.ok(match, `${name} must be declared`);
    return JSON.parse(match[1]!.replace(/'/g, '"')) as string[];
  };
  const delegated = list('DELEGATED_TOOLS');
  const leased = list('LEASE_TOOLS');
  assert.ok(leased.length > 0 && delegated.length > 0);
  for (const tool of leased) {
    assert.ok(delegated.includes(tool), `${tool} is leased but not delegated`);
  }
  assert.equal(
    delegated.includes('workspace.open'), false,
    'workspace.open resolves no workspace_id, so a delegation cannot constrain it and it must '
    + 'never appear in a delegated tool list',
  );
});

// -------------------------------------------------------------------------------------------
// The refusals, fired against a real temporary store
// -------------------------------------------------------------------------------------------

/**
 * A copy of the instrument pointed at a temporary store and config, with the interactive check
 * removed, so the *precondition* refusals can be exercised without a terminal and without ever
 * touching live state.
 *
 * Patching the copy is deliberate and narrow: the interactive check is asserted directly above,
 * against the real file. What is exercised here is everything after it.
 */
async function harness(t: test.TestContext, options: {
  /** What the config names. 'placeholder' is the state a correct activation starts from. */
  names?: 'placeholder' | 'delegation-only' | 'lease-already-named';
  /** Create a v5 session row and return its id. */
  withSession?: boolean;
  /** Extra sessions, with ages in minutes, to model a machine that has connected before. */
  extraSessionAgesMinutes?: readonly number[];
  /** Create a workspace row over a real git repository inside the temp tree. */
  withWorkspace?: boolean;
} = {}): Promise<{
  script: string; store: string; config: string; dir: string;
  sessionId?: string; workspaceId?: string; configBefore: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'wag-activation-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); });

  const storePath = join(dir, 'state.sqlite');
  const configPath = join(dir, 'wag.config.json');
  const workRoot = join(dir, 'workspace');
  await mkdir(workRoot, { recursive: true });

  let sessionId: string | undefined;
  let workspaceId: string | undefined;
  if (options.withSession || options.withWorkspace) {
    const { SqliteDurableStore } = await import('../src/durable-store.js');
    const { BROWSER_DELEGATION_ADAPTER_ID } = await import('../src/adapter-admission.js');
    const store = new SqliteDurableStore(storePath);
    try {
      if (options.withSession) {
        sessionId = store.getOrCreateAdapterSession({
          ownerId: store.getOrCreateLocalPrincipal(Date.now()).ownerId,
          adapterId: BROWSER_DELEGATION_ADAPTER_ID,
          correlationSha256: 'a'.repeat(64),
          createdAt: Date.now(),
        }).sessionId;
      }
      for (const [index, age] of (options.extraSessionAgesMinutes ?? []).entries()) {
        store.getOrCreateAdapterSession({
          ownerId: store.getOrCreateLocalPrincipal(Date.now()).ownerId,
          adapterId: BROWSER_DELEGATION_ADAPTER_ID,
          correlationSha256: String(index).padStart(64, 'b'),
          createdAt: Date.now() - age * 60_000,
        });
      }
      if (options.withWorkspace) {
        for (const argv of [
          ['init', '-b', 'work'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'T'],
        ]) execFileSync('git', ['-C', workRoot, ...argv], { stdio: 'ignore' });
        await writeFile(join(workRoot, 'seed.md'), '# seed\n', 'utf8');
        execFileSync('git', ['-C', workRoot, 'add', '.'], { stdio: 'ignore' });
        execFileSync('git', ['-C', workRoot, 'commit', '-m', 'seed'], { stdio: 'ignore' });
        workspaceId = store.openWorkspaceRecord({
          ownerId: store.getOrCreateLocalPrincipal(Date.now()).ownerId,
          sessionId: sessionId ?? 'session_unused',
          adapterId: BROWSER_DELEGATION_ADAPTER_ID,
          canonicalRoot: workRoot,
          backendKind: 'devspace',
          createdAt: Date.now(),
        }).workspaceId;
      }
    } finally { store.close(); }
  }

  const placeholder = 'uidel_PLACEHOLDER-NOT-ISSUED-0000000000000000';
  const mutation: Record<string, string> =
    options.names === 'delegation-only' ? { goalUiDelegationId: 'uidel_already000000000000' }
      // Placeholder *and* a lease already named: the state a half-edited config presents, and the
      // one in which overwriting the lease would silently replace a grant that may be in force.
      : options.names === 'lease-already-named'
        ? { goalUiDelegationId: placeholder, goalLeaseId: 'lease_already_in_force' }
        : { goalUiDelegationId: placeholder };
  // A complete, schema-valid config: the instrument reads the result back through the gateway's
  // own loader, so a fixture missing required fields would fail for the wrong reason.
  const configBefore = `${JSON.stringify({
    allowedRoots: [workRoot.split('\\').join('/')],
    devspace: { baseUrl: 'http://127.0.0.1:7676', resourceUrl: 'http://127.0.0.1:7676/mcp' },
    verifyProfiles: { unit: { argv: ['node', '--version'], timeoutMs: 30000, maxOutputTokens: 2000 } },
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath: storePath.split('\\').join('/'),
        ownerId: 'local.browser.operator',
        ...mutation,
      },
    },
  }, null, 2)}\n`;
  await writeFile(configPath, configBefore, 'utf8');

  const script = join(dir, 'activate-delegation-control.mjs');
  await cp(SCRIPT, script);
  const patched = (await readFile(script, 'utf8'))
    .replace(/const CONFIG = '[^']*';/, `const CONFIG = ${JSON.stringify(configPath)};`)
    .replace(/const STATE = [^;]*;/, `const STATE = ${JSON.stringify(storePath)};`)
    .replace('if (!process.stdin.isTTY) {', 'if (false) {');
  await writeFile(script, patched, 'utf8');
  return {
    script, store: storePath, config: configPath, dir, configBefore,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}

const runScript = async (script: string, args: readonly string[]) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

const ISSUE = ['--is', 'sue'].join('');

test('it refuses when no v5 session exists', async (t) => {
  const h = await harness(t);
  const result = await runScript(h.script, [ISSUE, '--session', 'session_x', '--workspace', 'ws_y', '--confirm']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no v5 session exists/);
});

test('it refuses when the config no longer holds the placeholder', async (t) => {
  const h = await harness(t, { names: 'delegation-only' });
  const result = await runScript(h.script, [ISSUE, '--session', 'session_x', '--workspace', 'ws_y', '--confirm']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /does not hold the placeholder/);
  assert.match(result.stderr, /already activated|never applied/);
});

test('it refuses without a session', async (t) => {
  const h = await harness(t);
  const result = await runScript(h.script, [ISSUE, '--root', h.dir, '--confirm']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--session is required/);
});

test('it refuses neither or both of --root and --workspace, because either is ambiguous', async (t) => {
  const h = await harness(t, { withSession: true, withWorkspace: true });
  for (const args of [
    [ISSUE, '--session', h.sessionId!, '--confirm'],
    [ISSUE, '--session', h.sessionId!, '--root', h.dir, '--workspace', h.workspaceId!, '--confirm'],
  ]) {
    const result = await runScript(h.script, args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.match(result.stderr, /exactly one of --root .* or --workspace/);
  }
});

test('it refuses when the kill switch is engaged, before anything else is read', async (t) => {
  const h = await harness(t);
  const { engageKillSwitch } = await import('../src/goal-lease-kill-switch.js');
  engageKillSwitch(join(h.store, '..'), 'activation-step test');
  const result = await runScript(h.script, [ISSUE, '--session', 'session_x', '--workspace', 'ws_y', '--confirm']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /kill switch is engaged/);
});

// -------------------------------------------------------------------------------------------
// The two states the failed live attempt produced, and the one it should have
// -------------------------------------------------------------------------------------------

/** Count issued grants by opening the store file, rather than reaching into the class. */
async function grantCounts(path: string): Promise<{ delegations: number; leases: number }> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const n = (table: string) => Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number }).n,
    );
    return { delegations: n('ui_delegations'), leases: n('goal_leases') };
  } finally { db.close(); }
}

const readMutation = async (config: string) =>
  (JSON.parse(await readFile(config, 'utf8')) as {
    repositoryEngineering?: { mutation?: Record<string, unknown> };
  }).repositoryEngineering?.mutation ?? {};

test('ACTIVATION FAIL: a config naming the delegation but no lease is refused', async (t) => {
  // This is exactly the state the previous instrument left behind: a delegation named, a lease
  // row issued and never named, so `goalLease` stays undefined and every effect still needs the
  // operator. Re-running must refuse rather than patch over it.
  const h = await harness(t, { names: 'delegation-only', withSession: true, withWorkspace: true });
  const result = await runScript(h.script, [
    ISSUE, '--session', h.sessionId!, '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /does not hold the placeholder/);

  const after = await readMutation(h.config);
  assert.equal(after.goalLeaseId, undefined, 'it must not have named a lease');
  assert.equal(
    await readFile(h.config, 'utf8'), h.configBefore,
    'a refusal must leave the config byte-identical',
  );
});

test('ACTIVATION PASS: both grants are issued, named together, and read back identical', async (t) => {
  const h = await harness(t, { withSession: true, withWorkspace: true });
  const result = await runScript(h.script, [
    ISSUE, '--session', h.sessionId!, '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ACTIVATED\./);

  const after = await readMutation(h.config);
  assert.match(String(after.goalUiDelegationId), /^uidel_[0-9a-f]{24}$/, 'a real delegation id');
  assert.match(String(after.goalLeaseId), /^lease_/, 'and a real lease id');

  const { SqliteDurableStore } = await import('../src/durable-store.js');
  const store = new SqliteDurableStore(h.store);
  try {
    const delegation = store.getUiDelegationRow(String(after.goalUiDelegationId));
    const lease = store.getGoalLeaseRow(String(after.goalLeaseId));
    assert.ok(delegation, 'the named delegation exists');
    assert.ok(lease, 'the named lease exists');

    const d = JSON.parse(delegation!.bindings) as Record<string, unknown>;
    const l = JSON.parse(lease!.bindings) as Record<string, unknown>;

    // The identities the config names are the identities the rows bind — the whole point.
    assert.equal(d.sessionId, h.sessionId);
    assert.equal(d.workspaceId, h.workspaceId);
    assert.deepEqual(l.admittedSessions, [h.sessionId]);
    assert.deepEqual(l.delegatedGoalIds, [d.goalId], 'the lease admits exactly this goal');
    assert.deepEqual(l.admittedAdapters, [d.adapterId]);
    for (const tool of l.allowedTools as string[]) {
      assert.ok((d.allowedTools as string[]).includes(tool), `${tool} leased but not delegated`);
    }
  } finally { store.close(); }
});

test('a second run over an activated config refuses and changes nothing', async (t) => {
  const h = await harness(t, { withSession: true, withWorkspace: true });
  const first = await runScript(h.script, [
    ISSUE, '--session', h.sessionId!, '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(first.code, 0, first.stderr);
  const afterFirst = await readFile(h.config, 'utf8');

  const second = await runScript(h.script, [
    ISSUE, '--session', h.sessionId!, '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(second.code, 2);
  assert.equal(await readFile(h.config, 'utf8'), afterFirst, 'the config is untouched by the refusal');
});

test('every refusal leaves the config byte-identical, so authority can never widen partially', async (t) => {
  for (const [what, args] of [
    ['no session', [ISSUE, '--session', 'session_missing', '--workspace', 'ws_missing', '--confirm']],
    ['missing workspace flag', [ISSUE, '--session', 'session_missing', '--confirm']],
  ] as const) {
    const h = await harness(t, { withSession: true, withWorkspace: true });
    const result = await runScript(h.script, [...args]);
    assert.equal(result.code, 2, `${what} must refuse`);
    assert.equal(await readFile(h.config, 'utf8'), h.configBefore, `${what} must not touch the config`);
    const counts = await grantCounts(h.store);
    assert.equal(counts.delegations, 0, `${what} must not have issued a delegation`);
    assert.equal(counts.leases, 0, `${what} must not have issued a lease`);
  }
});

test('it refuses when a lease is already named, rather than replacing one that may be in force', async (t) => {
  const h = await harness(t, {
    names: 'lease-already-named', withSession: true, withWorkspace: true,
  });
  const result = await runScript(h.script, [
    ISSUE, '--session', h.sessionId!, '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /already names a lease/);
  assert.equal(
    await readFile(h.config, 'utf8'), h.configBefore,
    'the existing lease name must survive untouched',
  );
  const counts = await grantCounts(h.store);
  assert.equal(counts.leases, 0, 'and no second lease may be minted');
});

test('it refuses a --session that is not the one live session', async (t) => {
  // Distinct from "no session exists": here a session *does* exist and the caller named a
  // different one. Binding a grant to a session the browser is not using either wastes the grant
  // or binds it somewhere nobody intended.
  const h = await harness(t, { withSession: true, withWorkspace: true });
  const wrong = 'session_00000000-0000-4000-8000-000000000000';
  assert.notEqual(wrong, h.sessionId);
  const result = await runScript(h.script, [
    ISSUE, '--session', wrong, '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /is not the one fresh session/);
  assert.equal(await readFile(h.config, 'utf8'), h.configBefore);
  const counts = await grantCounts(h.store);
  assert.equal(counts.delegations, 0);
  assert.equal(counts.leases, 0);
});

test('a stale session from an earlier browser does not block activation', async (t) => {
  // Sessions are durable rows and nothing prunes them, so any machine that has connected before
  // has old ones. Requiring the table to hold exactly one row made activation impossible there —
  // and the advice it printed, to restart WAG, could not have cleared them.
  const h = await harness(t, {
    withSession: true, withWorkspace: true, extraSessionAgesMinutes: [600, 1500],
  });
  const result = await runScript(h.script, [
    ISSUE, '--session', h.sessionId!, '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /exactly one fresh v5 session/);
});

test('two fresh sessions are ambiguous and refuse, because either could be the live browser', async (t) => {
  const h = await harness(t, {
    withSession: true, withWorkspace: true, extraSessionAgesMinutes: [1],
  });
  const result = await runScript(h.script, [
    ISSUE, '--session', h.sessionId!, '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /2 v5 sessions are fresh/);
  assert.equal(await readFile(h.config, 'utf8'), h.configBefore);
});

test('only stale sessions refuses, and says so rather than blaming the reference', async (t) => {
  const h = await harness(t, { withWorkspace: true, extraSessionAgesMinutes: [600] });
  const result = await runScript(h.script, [
    ISSUE, '--session', 'session_whatever', '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no v5 session is younger than/);
});

// -------------------------------------------------------------------------------------------
// The workspace the grant is bound to must be one the v5 session owns
// -------------------------------------------------------------------------------------------

/**
 * Re-own the fixture workspace, to model the states the production dead end and its neighbours
 * present. `INSERT OR REPLACE` through the store's own handle, the same reach the delegated
 * suites already take.
 */
async function reownWorkspace(storePath: string, workspaceId: string, over: {
  ownerId?: string; sessionId?: string; adapterId?: string; canonicalRoot: string;
}): Promise<void> {
  const { SqliteDurableStore } = await import('../src/durable-store.js');
  const { giveWorkspace } = await import('./support/workspace-fixture.js');
  const store = new SqliteDurableStore(storePath);
  try {
    const existing = store.getWorkspace(workspaceId);
    assert.ok(existing, 'the fixture workspace must exist before it is re-owned');
    giveWorkspace(store, {
      workspaceId,
      ownerId: over.ownerId ?? existing.ownerId,
      sessionId: over.sessionId ?? existing.sessionId,
      adapterId: over.adapterId ?? existing.adapterId,
      canonicalRoot: over.canonicalRoot,
    });
  } finally { store.close(); }
}

const workspaceRootOf = async (storePath: string, workspaceId: string): Promise<string> => {
  const { SqliteDurableStore } = await import('../src/durable-store.js');
  const store = new SqliteDurableStore(storePath);
  try { return store.getWorkspace(workspaceId)!.canonicalRoot; } finally { store.close(); }
};

test('ACTIVATION FAIL: a v4-owned workspace and a v5 session is refused, and mints nothing', async (t) => {
  // The exact production state of 2026-09-22. Previously this activated cleanly and produced a
  // delegation bound to a workspace the v5 caller could never act in.
  const h = await harness(t, { withSession: true, withWorkspace: true });
  const root = await workspaceRootOf(h.store, h.workspaceId!);
  await reownWorkspace(h.store, h.workspaceId!, {
    adapterId: 'browser.chatgpt.native.operator.v4',
    sessionId: 'session_v4_owner',
    canonicalRoot: root,
  });

  const result = await runScript(h.script, [
    ISSUE, '--session', h.sessionId!, '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /is owned by/);
  assert.match(result.stderr, /browser\.chatgpt\.native\.operator\.v4/);
  assert.match(result.stderr, /spend a budget slot on work/);

  assert.deepEqual(await grantCounts(h.store), { delegations: 0, leases: 0 },
    'a refusal must mint neither grant');
  assert.equal(await readFile(h.config, 'utf8'), h.configBefore,
    'a refusal must leave the config byte-identical');
});

test('ACTIVATION FAIL: a workspace owned by another session, or another principal, is refused', async (t) => {
  for (const over of [
    { sessionId: 'session_v5_someone_else' },
    { ownerId: 'owner_someone_else' },
  ]) {
    const h = await harness(t, { withSession: true, withWorkspace: true });
    const root = await workspaceRootOf(h.store, h.workspaceId!);
    await reownWorkspace(h.store, h.workspaceId!, { ...over, canonicalRoot: root });

    const result = await runScript(h.script, [
      ISSUE, '--session', h.sessionId!, '--workspace', h.workspaceId!, '--confirm',
    ]);
    assert.equal(result.code, 2, JSON.stringify(over) + result.stdout + result.stderr);
    assert.match(result.stderr, /is owned by/);
    assert.deepEqual(await grantCounts(h.store), { delegations: 0, leases: 0 });
  }
});

test('ACTIVATION PASS: a workspace this v5 session owns activates, and the grant names it', async (t) => {
  const h = await harness(t, { withSession: true, withWorkspace: true });
  const result = await runScript(h.script, [
    ISSUE, '--session', h.sessionId!, '--workspace', h.workspaceId!, '--confirm',
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /is owned by this v5 session/);

  const after = await readMutation(h.config);
  assert.match(String(after.goalUiDelegationId), /^uidel_/);
  assert.match(String(after.goalLeaseId), /^lease_/);

  // The delegation binds the workspace that was checked, not some other one.
  const { SqliteDurableStore } = await import('../src/durable-store.js');
  const store = new SqliteDurableStore(h.store);
  try {
    const row = store.getUiDelegationRow(String(after.goalUiDelegationId));
    const bindings = JSON.parse(row!.bindings) as { workspaceId: string; sessionId: string };
    assert.equal(bindings.workspaceId, h.workspaceId);
    assert.equal(bindings.sessionId, h.sessionId);
  } finally { store.close(); }
});

test('--root fails closed without the DevSpace token, rather than minting a workspace some other way', async (t) => {
  // The mint goes through `AdmittedWorkspaceService.open`, which needs the running DevSpace. With
  // no way to reach it the instrument refuses; it does not fall back to writing a row itself.
  const h = await harness(t, { withSession: true, withWorkspace: true });
  const root = await workspaceRootOf(h.store, h.workspaceId!);
  const result = await runScript(h.script, [ISSUE, '--session', h.sessionId!, '--root', root, '--confirm']);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /DEVSPACE_OAUTH_OWNER_TOKEN is not set/);
  assert.deepEqual(await grantCounts(h.store), { delegations: 0, leases: 0 });
});

test('--root outside the configured allowedRoots is refused before anything is reached', async (t) => {
  const h = await harness(t, { withSession: true, withWorkspace: true });
  const result = await runScript(h.script, [
    ISSUE, '--session', h.sessionId!, '--root', tmpdir(), '--confirm',
  ]);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /not an allowed workspace root/);
  assert.deepEqual(await grantCounts(h.store), { delegations: 0, leases: 0 });
});
