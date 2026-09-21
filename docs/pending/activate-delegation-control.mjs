/**
 * The single human activation step — **for a human to run**. Claude cannot run this.
 *
 * ```bash
 * node docs/pending/activate-delegation-control.mjs --issue \
 *   --session  session_<uuid>            the live v5 session, from --sessions
 *   --workspace ws_<uuid>                the workspace the candidate named
 *   --confirm
 * ```
 *
 * ## Why Claude cannot run it, by construction rather than by promise
 *
 * The file is named `activate-delegation-control.mjs` deliberately. The applied PreToolUse guard
 * matches `/\bdelegation-control(?:\.[cm]?[jt]s)?\b/i` beside `--issue` under a script runner, so
 * `node docs/pending/activate-delegation-control.mjs --issue …` is refused for Claude at the tool
 * layer. That is verified by `test/activation-step.test.ts`, which drives the live guard.
 *
 * A name is not a mechanism, so there is a second layer: this script refuses to run without an
 * interactive stdin. Something that mints authority should not run headless.
 *
 * ## What it does, in this order, and why the order matters
 *
 *   1. every precondition, writing nothing
 *   2. issue the Goal UI Delegation and verify the stored row
 *   3. issue the matching Goal Lease for the same goal and verify the stored row
 *   4. ONE atomic write naming both in the live config
 *   5. read the config back through the gateway's own loader and verify both
 *
 * Both grants are minted before either is named, and they are named in a single atomic replace.
 * A row that is not named in configuration is inert, so every failure before step 4 leaves the
 * machine with no new authority at all, and step 4 either lands whole or not at all. There is no
 * ordering in which effect authority ends up broader than intended.
 *
 * ## What it refuses
 *
 * Stale, ambiguous or already-activated state, and any binding wider than the one intended.
 */
import { createRequire } from 'node:module';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const REPO = 'E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1';
const CONFIG = 'E:/AI-BROWSER/wag-acceptance/wag-live.config.json';
const PLACEHOLDER = 'uidel_PLACEHOLDER-NOT-ISSUED-0000000000000000';
const STATE = join(process.env.LOCALAPPDATA, 'WebAgentGateway', 'browser-operator-v4.sqlite');

/** Bounds. Every one of these is deliberately smaller than the ceiling the policy would allow. */
const DELEGATION_TTL_MINUTES = 120;      // ceiling is 240
const LEASE_TTL_MINUTES = 240;           // ceiling is 720
const MAX_ACTIONS = 8;
const DELEGATED_TOOLS = ['mutation.preview', 'verify.preview', 'git.commit'];
const LEASE_TOOLS = ['mutation.preview', 'git.commit'];
const LEASE_PATH_PATTERNS = ['*.js', '*.md'];
const LEASE_MAX_FILES = 4;
const LEASE_MAX_BYTES = 64 * 1024;
const LEASE_MAX_DIFF_BYTES = 16 * 1024;
const ORIGIN = 'https://chatgpt.com';
const SESSION_MAX_AGE_MINUTES = 120;
const ADAPTER = 'browser.chatgpt.native.delegation.v5';
const CONTROLLER = 'local.operator.cli';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
};

const out = (line = '') => process.stdout.write(`${line}\n`);
const fail = (why) => { process.stderr.write(`\nREFUSED: ${why}\n`); process.exit(2); };

async function main() {
  if (!flag('--issue') || !flag('--confirm')) {
    out('usage: node docs/pending/activate-delegation-control.mjs --issue --session <id> '
      + '--workspace <id> --confirm');
    out('');
    out('Issues ONE bounded Goal UI Delegation, names it in the live config, and issues ONE');
    out('matching Goal Lease for the same goal. Refuses stale, ambiguous or widened state.');
    return 0;
  }
  if (!process.stdin.isTTY) {
    fail('stdin is not a terminal. Something that mints authority does not run headless.');
  }

  const sessionId = value('--session');
  const workspaceId = value('--workspace');
  if (!sessionId || !workspaceId) fail('--session and --workspace are both required');

  const { SqliteDurableStore } = require(join(REPO, 'dist/durable-store.js'));
  const { UiDelegationControlPlane, createControllerPlaneKey } =
    require(join(REPO, 'dist/goal-ui-delegation-control.js'));
  const { isKillSwitchEngaged } = require(join(REPO, 'dist/goal-lease-kill-switch.js'));
  const { validateBindings } = require(join(REPO, 'dist/goal-lease.js'));
  const { validateDelegationBindings } = require(join(REPO, 'dist/goal-ui-delegation.js'));

  const now = Date.now();
  const store = new SqliteDurableStore(STATE);
  try {
    // ---- 1. preconditions, writing nothing -------------------------------------------------
    out('preconditions');

    if (isKillSwitchEngaged(dirname(STATE))) {
      fail('the local kill switch is engaged. Clear it deliberately before granting authority.');
    }
    out('  ok   kill switch clear');

    const configText = await readFile(CONFIG, 'utf8');
    const occurrences = configText.split(PLACEHOLDER).length - 1;
    if (occurrences === 0) {
      fail(`the live config does not hold the placeholder. Either it was never applied, or this `
        + `is already activated. Refusing to guess. (${CONFIG})`);
    }
    if (occurrences !== 1) fail(`the placeholder occurs ${occurrences} times; expected exactly 1`);
    out('  ok   config holds exactly one placeholder');

    // Checked here, in the preconditions, and not at the write. A mutation proved why: with the
    // check at the write, a config that already named a lease was refused *after* a fresh lease had
    // been minted, leaving a stray grant row behind. Inert, because an unnamed row grants nothing —
    // but a refusal should leave the store exactly as it found it.
    if (configText.includes('"goalLeaseId"')) {
      fail('the config already names a lease; refusing to replace one that may be in force');
    }
    out('  ok   config names no lease yet');

    const sessions = store.listAdapterSessions(ADAPTER);
    if (sessions.length === 0) fail('no v5 session exists. Connect the extension and observe a candidate first.');
    if (sessions.length !== 1) {
      process.stderr.write('\nv5 sessions found:\n');
      for (const s of sessions) {
        process.stderr.write(`  ${s.sessionId}  admitted ${new Date(s.createdAt).toISOString()}\n`);
      }
      fail(`${sessions.length} v5 sessions exist, so which one the browser is using is ambiguous. `
        + 'Restart WAG to clear them, reconnect once, and re-run.');
    }
    const session = sessions[0];
    if (session.sessionId !== sessionId) {
      fail(`--session ${sessionId} is not the one live session (${session.sessionId}). `
        + 'Refusing to bind a grant to a session the browser is not using.');
    }
    const ageMinutes = (now - session.createdAt) / 60_000;
    if (!(ageMinutes >= 0) || ageMinutes > SESSION_MAX_AGE_MINUTES) {
      fail(`the session is ${Math.round(ageMinutes)} minutes old (limit ${SESSION_MAX_AGE_MINUTES}). `
        + 'A stale session may belong to a browser that is gone. Reconnect and re-run.');
    }
    out(`  ok   exactly one v5 session, ${Math.round(ageMinutes)} min old, matches --session`);

    const config = JSON.parse(configText);
    const allowedRoots = config.allowedRoots ?? [];
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) fail(`workspace ${workspaceId} does not exist`);
    const root = workspace.canonicalRoot;
    const rootAllowed = allowedRoots.some(
      (r) => r.split('\\').join('/').replace(/\/+$/, '').toLowerCase()
        === root.split('\\').join('/').replace(/\/+$/, '').toLowerCase(),
    );
    if (!rootAllowed) fail(`workspace root ${root} is not one of the configured allowedRoots`);
    out(`  ok   workspace resolves to an allowed root: ${root}`);

    const goalId = `goal_delegated_run_${now.toString(36)}`;
    if (store.countLiveDelegationsForGoal(goalId, now) > 0) fail('a live delegation already exists for this goal');
    out('  ok   no live delegation for the goal');

    // A branch and a HEAD for the commit binding, read now so the lease CAS is exact.
    let branch;
    let headSha;
    try {
      branch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
      headSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      fail(`${root} is not a git repository, so a commit-granting lease cannot bind a HEAD`);
    }
    if (!/^[0-9a-f]{40}$/.test(headSha)) fail(`HEAD is not a sha: ${headSha}`);
    if (branch === 'HEAD') fail('the workspace is in detached HEAD; a lease must bind a named branch');
    if (branch === 'main' || branch === 'master') {
      fail(`refusing to bind a commit lease to ${branch}`);
    }
    out(`  ok   git: branch ${branch} at ${headSha.slice(0, 12)}`);

    // ---- 2. issue the delegation -----------------------------------------------------------
    const delegationBindings = {
      goalId,
      controllerId: CONTROLLER,
      allowedOrigins: [ORIGIN],
      allowedTools: [...DELEGATED_TOOLS],
      workspaceId,
      sessionId,
      adapterId: ADAPTER,
      maxActions: MAX_ACTIONS,
    };
    const malformedDelegation = validateDelegationBindings(delegationBindings);
    if (malformedDelegation) fail(`intended delegation bindings are malformed: ${malformedDelegation}`);

    out('');
    out('issuing');
    const control = new UiDelegationControlPlane({ store, key: createControllerPlaneKey(CONTROLLER) });
    const { delegationId } = control.issue({
      goalId, ttlMs: DELEGATION_TTL_MINUTES * 60_000, bindings: delegationBindings,
    });
    out(`  ok   delegation ${delegationId}`);

    // ---- 3. verify it reads back exactly ---------------------------------------------------
    const storedDelegation = store.getUiDelegationRow(delegationId);
    if (!storedDelegation) fail('the delegation did not persist');
    const readBack = JSON.parse(storedDelegation.bindings);
    if (JSON.stringify(readBack) !== JSON.stringify(delegationBindings)) {
      fail('the stored delegation bindings are not the ones intended — refusing to continue');
    }
    if (storedDelegation.expiresAt - storedDelegation.notBefore > DELEGATION_TTL_MINUTES * 60_000) {
      fail('the stored window is wider than intended');
    }
    out('  ok   stored bindings are byte-identical to the intended ones');

    // ---- 4. issue the matching lease, still writing nothing to configuration -------------
    //
    // Both grants are minted *before* either is named. A row that is not named in configuration
    // is inert — that is the property the whole design rests on — so every failure up to the
    // single write below leaves the machine with no new authority at all.
    const leaseBindings = {
      workspaceRoots: [root],
      allowedTools: [...LEASE_TOOLS],
      pathPatterns: [...LEASE_PATH_PATTERNS],
      maxFiles: LEASE_MAX_FILES,
      maxBytes: LEASE_MAX_BYTES,
      maxDiffBytes: LEASE_MAX_DIFF_BYTES,
      admittedSessions: [sessionId],
      admittedAdapters: [ADAPTER],
      delegatedGoalIds: [goalId],
      commitSemantics: 'commit-to-bound-branch',
      branch,
      headSha,
    };
    const malformedLease = validateBindings(leaseBindings);
    if (malformedLease) fail(`intended lease bindings are malformed: ${malformedLease}`);

    const leaseId = `lease_${now.toString(36)}_${randomBytes(4).toString('hex')}`;
    store.insertGoalLease({
      leaseId,
      createdAt: now,
      notBefore: now - 1_000,
      expiresAt: now + LEASE_TTL_MINUTES * 60_000,
      bindings: JSON.stringify(leaseBindings),
    });
    const storedLease = store.getGoalLeaseRow(leaseId);
    if (!storedLease) fail('the lease did not persist');
    if (JSON.stringify(JSON.parse(storedLease.bindings)) !== JSON.stringify(leaseBindings)) {
      fail('the stored lease bindings are not the ones intended');
    }
    if (storedLease.expiresAt - storedLease.notBefore > LEASE_TTL_MINUTES * 60_000 + 2_000) {
      fail('the stored lease window is wider than intended');
    }
    out(`  ok   lease ${leaseId}`);

    // ---- 5. ONE atomic write naming BOTH grants ------------------------------------------
    //
    // One write, not two. The first version of this instrument named the delegation, then issued
    // the lease, then named the lease — and stopped after the second step, leaving a live-looking
    // lease row that the runtime never loaded. `goalLeaseId` absent means `goalLease` is
    // undefined, no admission pass is created, and every effect still needs the operator. It read
    // as activated and was not.
    //
    // Two writes are also two windows in which a crash leaves configuration naming one grant and
    // not the other. Naming both in a single atomic replace collapses the outcomes to exactly two:
    // neither grant is named and nothing was granted, or both are and the grant is the intended
    // one. There is no ordering in which effect authority ends up broader than intended, because
    // the delegation and the lease become live in the same instant or not at all.
    out('');
    out('naming both grants in configuration');
    const current = await readFile(CONFIG, 'utf8');
    // Re-read rather than reused: the precondition above ran before the grants were minted, and
    // this is the last moment before the write. Both are kept — the first so a refusal costs
    // nothing, the second so a config edited underneath us is still caught.
    if (current.includes('"goalLeaseId"')) {
      fail('the config gained a lease name while this was running; refusing to overwrite it');
    }
    if (current.split(PLACEHOLDER).length - 1 !== 1) {
      fail('the placeholder is no longer present exactly once; the config changed under us');
    }
    const named = current.replace(
      `"goalUiDelegationId": "${PLACEHOLDER}"`,
      `"goalUiDelegationId": "${delegationId}",\n      "goalLeaseId": "${leaseId}"`,
    );
    if (named === current) {
      fail('the placeholder is not in the expected "goalUiDelegationId" position; refusing to guess');
    }
    // Parsed before it is written, so a malformed result never reaches disk.
    let candidate;
    try { candidate = JSON.parse(named); }
    catch (error) { fail(`the patched config is not JSON: ${String(error)}`); }
    if (candidate.repositoryEngineering?.mutation?.goalUiDelegationId !== delegationId
      || candidate.repositoryEngineering?.mutation?.goalLeaseId !== leaseId) {
      fail('the patched config does not name both grants; refusing to write it');
    }

    // Atomic: write beside the target, then rename over it. A crash mid-write leaves the original.
    const temporary = `${CONFIG}.activating`;
    await writeFile(temporary, named, 'utf8');
    await rename(temporary, CONFIG);

    // Read back from disk through the real loader, so the check is the gateway's own parse.
    const { loadPrivateGatewayConfig } = require(join(REPO, 'dist/private-config.js'));
    let live;
    try { live = await loadPrivateGatewayConfig(CONFIG); }
    catch (error) {
      await writeFile(CONFIG, current, 'utf8');
      fail(`the written config does not load; the original was restored. ${String(error)}`);
    }
    const liveMutation = live.repositoryEngineering?.mutation ?? {};
    if (liveMutation.goalUiDelegationId !== delegationId || liveMutation.goalLeaseId !== leaseId) {
      await writeFile(CONFIG, current, 'utf8');
      fail('the config does not name both grants after the write; the original was restored');
    }
    out(`  ok   goalUiDelegationId = ${delegationId}`);
    out(`  ok   goalLeaseId        = ${leaseId}`);

    // ---- 6. the composition, asserted ------------------------------------------------------
    out('');
    out('composition');
    const d = JSON.parse(store.getUiDelegationRow(delegationId).bindings);
    const l = JSON.parse(store.getGoalLeaseRow(leaseId).bindings);
    const checks = [
      ['the lease admits exactly this delegation\'s goal', JSON.stringify(l.delegatedGoalIds) === JSON.stringify([d.goalId])],
      ['both bind the same session', l.admittedSessions.length === 1 && l.admittedSessions[0] === d.sessionId],
      ['both bind the same adapter', l.admittedAdapters.length === 1 && l.admittedAdapters[0] === d.adapterId],
      ['the lease tools are a subset of the delegated tools', l.allowedTools.every((t) => d.allowedTools.includes(t))],
      ['the delegation names one origin, exactly', JSON.stringify(d.allowedOrigins) === JSON.stringify([ORIGIN])],
      ['the delegation window is within its own ceiling', storedDelegation.expiresAt - storedDelegation.notBefore <= 4 * 60 * 60_000],
      ['the lease window is within its own ceiling', storedLease.expiresAt - storedLease.notBefore <= 12 * 60 * 60_000],
      ['the delegated budget is bounded', d.maxActions === MAX_ACTIONS && MAX_ACTIONS <= 8],
    ];
    let bad = 0;
    for (const [what, ok] of checks) { if (!ok) bad += 1; out(`  ${ok ? 'ok  ' : 'BAD '} ${what}`); }
    if (bad > 0) fail(`${bad} composition check(s) failed. Revoke both grants before proceeding.`);

    out('');
    out('ACTIVATED.');
    out(`  goal        ${goalId}`);
    out(`  delegation  ${delegationId}   (${DELEGATION_TTL_MINUTES} min, ${MAX_ACTIONS} actions)`);
    out(`  lease       ${leaseId}   (${LEASE_TTL_MINUTES} min, ${LEASE_MAX_FILES} files)`);
    out('  both are named in configuration; neither is in force until WAG restarts');
    out(`  session     ${sessionId}`);
    out(`  workspace   ${workspaceId}  ->  ${root}`);
    out(`  branch      ${branch} @ ${headSha.slice(0, 12)}`);
    out('');
    out('Both grants are now named in configuration. Restart WAG so it re-reads them.');
    out('To stop everything at any time: npm run lease:stop');
    return 0;
  } finally {
    store.close();
  }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
