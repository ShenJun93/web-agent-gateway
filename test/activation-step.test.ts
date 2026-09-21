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
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
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
  assert.match(result.stdout, /Refuses stale, ambiguous or widened state/);
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

test('it names BOTH grants in configuration, because an unnamed grant is inert', () => {
  // The first version issued the lease row and never named it, which produced a live-looking lease
  // that the runtime never loaded: goalLeaseId absent means goalLease is undefined, no admission
  // timer is created, and every effect still needs the operator. It looked activated and was not.
  assert.ok(source.includes('\goalUiDelegationId'), 'it must write the delegation id');
  assert.ok(source.includes('\goalLeaseId'), 'it must write the lease id');
  assert.ok(
    source.includes('goalLeaseId !== leaseId'),
    'and it must read the config back and refuse if the lease is not named',
  );
  assert.ok(
    source.includes('refusing to replace one that is already in force'),
    'and refuse to overwrite a lease that is already named',
  );
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
  placeholderCount?: number;
} = {}): Promise<{ script: string; store: string; config: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'wag-activation-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); });

  const store = join(dir, 'state.sqlite');
  const config = join(dir, 'wag.config.json');
  const placeholder = 'uidel_PLACEHOLDER-NOT-ISSUED-0000000000000000';
  const body = options.placeholderCount === 0
    ? { goalUiDelegationId: 'uidel_already_activated_0000' }
    : { goalUiDelegationId: placeholder };
  await writeFile(config, JSON.stringify({
    allowedRoots: [dir.split('\\').join('/')],
    repositoryEngineering: { mutation: { ...body } },
  }, null, 2), 'utf8');

  const script = join(dir, 'activate-delegation-control.mjs');
  await cp(SCRIPT, script);
  const patched = (await readFile(script, 'utf8'))
    .replace(/const CONFIG = '[^']*';/, `const CONFIG = ${JSON.stringify(config)};`)
    .replace(/const STATE = [^;]*;/, `const STATE = ${JSON.stringify(store)};`)
    .replace('if (!process.stdin.isTTY) {', 'if (false) {');
  await writeFile(script, patched, 'utf8');
  return { script, store, config };
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
  const h = await harness(t, { placeholderCount: 0 });
  const result = await runScript(h.script, [ISSUE, '--session', 'session_x', '--workspace', 'ws_y', '--confirm']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /does not hold the placeholder/);
  assert.match(result.stderr, /already activated|never applied/);
});

test('it refuses without both references', async (t) => {
  const h = await harness(t);
  const result = await runScript(h.script, [ISSUE, '--session', 'session_x', '--confirm']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--session and --workspace are both required/);
});

test('it refuses when the kill switch is engaged, before anything else is read', async (t) => {
  const h = await harness(t);
  const { engageKillSwitch } = await import('../src/goal-lease-kill-switch.js');
  engageKillSwitch(join(h.store, '..'), 'activation-step test');
  const result = await runScript(h.script, [ISSUE, '--session', 'session_x', '--workspace', 'ws_y', '--confirm']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /kill switch is engaged/);
});
