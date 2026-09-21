/**
 * The single human activation step — **for a human to run**. Claude cannot run this.
 *
 * ```bash
 * node docs/pending/activate-delegation-control.mjs --issue \
 *   --session  session_<uuid>            the live v5 session, from --sessions
 *   --root     E:/path/to/checkout       the approved root; a NEW v5-owned workspace is minted
 *   --confirm
 *
 * # or, to bind a workspace the same v5 session already owns:
 * #   --workspace ws_<uuid>              refused unless that exact tuple owns it
 * ```
 *
 * ## The workspace, and why it is minted here
 *
 * A delegation binds one `workspaceId`, and every tool resolves a workspace through
 * `AdmittedWorkspaceService`, which admits a row only when the owner, session **and** adapter all
 * match. So a delegation bound to a workspace its own session does not own authorises work that
 * cannot run — and it costs a budget slot to find that out, because the refusal happens at
 * execution, after the CLAIM.
 *
 * Measured in production on 2026-09-22: every workspace in the store was owned by a
 * `…operator.v4` session, the delegated caller was `…delegation.v5`, and the delegated Run was
 * admitted, spent a slot, wrote its audit row and produced nothing.
 *
 * So the workspace is minted **here**, for the exact v5 tuple the delegation will bind, through the
 * gateway's own workspace service — the same `canonicalWorkspace` check against the same
 * `allowedRoots`, the same DevSpace open, the same row shape. There is no second workspace
 * subsystem, no ownership transfer and no row cloning. The human names the root on the command
 * line; no page, provider or proposal can choose or widen it.
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
 *   1. every precondition, writing nothing — including who owns the workspace, if one was named
 *   2. mint the v5-owned workspace (`--root`), or verify the named one is owned, and read it back
 *   3. issue the Goal UI Delegation bound to that workspace, and verify the stored row
 *   4. issue the matching Goal Lease for the same goal and verify the stored row
 *   5. ONE atomic write naming both in the live config
 *   6. read the config back through the gateway's own loader and verify both
 *
 * Both grants are minted before either is named, and they are named in a single atomic replace.
 * A row that is not named in configuration is inert, so every failure before step 5 leaves the
 * machine with no new authority at all, and step 5 either lands whole or not at all. There is no
 * ordering in which effect authority ends up broader than intended.
 *
 * Step 2 writes a workspace row, which is why it is numbered separately rather than folded into
 * the preconditions. A workspace is not authority: only the tuple that owns it can name it, and
 * naming it does nothing until a configured delegation binds it. A failure between steps 2 and 5
 * therefore leaves a workspace and no grant — which is the same state the machine was in before,
 * plus one row nobody can reach.
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
      + '(--root <path> | --workspace <id>) --confirm');
    out('');
    out('Mints a v5-owned workspace at --root (or reuses --workspace, if that exact v5 session');
    out('owns it), issues ONE bounded Goal UI Delegation bound to it, issues ONE matching Goal');
    out('Lease for the same goal, and names both in one atomic write. Refuses stale, ambiguous,');
    out('widened or foreign-owned state.');
    return 0;
  }
  if (!process.stdin.isTTY) {
    fail('stdin is not a terminal. Something that mints authority does not run headless.');
  }

  const sessionId = value('--session');
  const suppliedWorkspaceId = value('--workspace');
  const suppliedRoot = value('--root');
  if (!sessionId) fail('--session is required');
  if (!suppliedWorkspaceId === !suppliedRoot) {
    fail('give exactly one of --root (mint a new v5-owned workspace) or --workspace (reuse one '
      + 'this same v5 session already owns)');
  }

  const { SqliteDurableStore } = require(join(REPO, 'dist/durable-store.js'));
  const { UiDelegationControlPlane, createControllerPlaneKey } =
    require(join(REPO, 'dist/goal-ui-delegation-control.js'));
  const { isKillSwitchEngaged } = require(join(REPO, 'dist/goal-lease-kill-switch.js'));
  const { validateBindings } = require(join(REPO, 'dist/goal-lease.js'));
  const { validateDelegationBindings } = require(join(REPO, 'dist/goal-ui-delegation.js'));

  const now = Date.now();
  const store = new SqliteDurableStore(STATE);
  // Declared beside the store because the DevSpace session opened inside the try has to be
  // released by the same `finally`.
  let closeRuntime;
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

    // Sessions accumulate: `adapter_sessions` rows are durable and nothing prunes them, so every
    // browser that has ever connected leaves one behind. An earlier version of this check required
    // exactly one row in the table and told the operator to "restart WAG to clear them" — which
    // cannot work, because a restart does not touch durable rows. It would have made activation
    // impossible on any machine that had connected twice.
    //
    // What actually matters is not how many sessions have ever existed but how many are *fresh*:
    // a session older than the window belongs to a browser that is very likely gone, and binding a
    // grant to it either wastes the grant or binds it somewhere nobody is watching.
    const all = store.listAdapterSessions(ADAPTER);
    if (all.length === 0) {
      fail('no v5 session exists. Connect the extension and let it observe one candidate first.');
    }
    const ageOf = (record) => (now - record.createdAt) / 60_000;
    const fresh = all.filter((record) => {
      const age = ageOf(record);
      return age >= 0 && age <= SESSION_MAX_AGE_MINUTES;
    });
    if (fresh.length === 0) {
      process.stderr.write('\nv5 sessions, newest first:\n');
      for (const record of all) {
        process.stderr.write(
          `  ${record.sessionId}  ${Math.round(ageOf(record))} min old\n`,
        );
      }
      fail(`no v5 session is younger than ${SESSION_MAX_AGE_MINUTES} minutes. A stale session `
        + 'belongs to a browser that is probably gone. Reconnect, observe one candidate, re-run.');
    }
    // "Exactly one fresh session" was the second version of this rule, and the live run of
    // 2026-09-22 proved it unworkable too. Sessions are minted per browser *context*, and a
    // reconnect, a reload or a second tab each mint one — so three fresh sessions existed within
    // two minutes of a single extension reload. A session's age never resets either, because
    // re-admitting with the same correlation returns the same row. So the rule could not be
    // satisfied by waiting, by reconnecting, or by anything the operator could reasonably do.
    //
    // What the rule was actually protecting against is binding a grant to a context the browser is
    // not using. The newest fresh session is, by construction, the one most recently admitted —
    // so requiring `--session` to be *that* one enforces the same property without an unsatisfiable
    // precondition. Sessions are still refused when stale, and a `--session` that is not the newest
    // is still refused outright.
    //
    // `listAdapterSessions` orders by `created_at DESC`, so `fresh[0]` is the newest.
    const session = fresh[0];
    const newest = fresh.filter((record) => record.createdAt === session.createdAt);
    if (newest.length !== 1) {
      // A genuine tie: two contexts admitted in the same millisecond. Nothing here can tell them
      // apart, so this refuses rather than picking one.
      process.stderr.write('\nfresh v5 sessions tied for newest:\n');
      for (const record of newest) {
        process.stderr.write(`  ${record.sessionId}  createdAt ${record.createdAt}\n`);
      }
      fail(`${newest.length} v5 sessions share the newest timestamp, so which one the browser is `
        + 'using is genuinely ambiguous. Reconnect once and re-run.');
    }
    if (session.sessionId !== sessionId) {
      process.stderr.write('\nfresh v5 sessions, newest first:\n');
      for (const record of fresh) {
        process.stderr.write(`  ${record.sessionId}  ${Math.round(ageOf(record))} min old\n`);
      }
      fail(`--session ${sessionId} is not the newest fresh v5 session (${session.sessionId}). `
        + 'Refusing to bind a grant to a session the browser is not using.');
    }
    out(`  ok   --session is the newest of ${fresh.length} fresh v5 session(s), `
      + `${Math.round(ageOf(session))} min old`);

    // The caller tuple every later check is measured against. All three fields come from the
    // durable session row, never from a flag: `--session` selects which row, and the row says who
    // owns it. A delegation bound to any other tuple is the defect this instrument now refuses.
    const caller = {
      ownerId: session.ownerId,
      sessionId: session.sessionId,
      adapterId: ADAPTER,
    };
    if (caller.adapterId !== session.adapterId) {
      fail(`session ${sessionId} is on adapter ${session.adapterId}, not ${ADAPTER}`);
    }

    const { loadPrivateGatewayConfig } = require(join(REPO, 'dist/private-config.js'));
    const config = await loadPrivateGatewayConfig(CONFIG);
    const { canonicalWorkspace } = require(join(REPO, 'dist/path-policy.js'));

    // One notion of "is this root allowed", and it is the gateway's own. The previous version
    // lower-cased and slash-normalised the strings itself, which is a second, subtly different
    // answer to a question `canonicalWorkspace` already answers — and the one the tools will use.
    let root;
    if (suppliedWorkspaceId) {
      const existing = store.getWorkspace(suppliedWorkspaceId);
      if (!existing) fail(`workspace ${suppliedWorkspaceId} does not exist`);
      // The check the production dead end was missing. A workspace another owner, session or
      // adapter opened is refused here, where a human is present and nothing has been minted yet.
      if (existing.ownerId !== caller.ownerId
        || existing.sessionId !== caller.sessionId
        || existing.adapterId !== caller.adapterId) {
        fail(`workspace ${suppliedWorkspaceId} is owned by `
          + `${existing.adapterId} / ${existing.sessionId}, not by the v5 session `
          + `${caller.sessionId}. A delegation bound to it would spend a budget slot on work `
          + 'every tool would refuse. Pass --root instead and a new one will be minted.');
      }
      try { root = await canonicalWorkspace(existing.canonicalRoot, config.allowedRoots); }
      catch (error) { fail(`workspace root is not allowed: ${String(error)}`); }
      if (root !== existing.canonicalRoot) {
        fail('the stored root no longer canonicalises to itself; refusing to bind it');
      }
      out(`  ok   workspace ${suppliedWorkspaceId} is owned by this v5 session`);
      out(`  ok   root is allowed: ${root}`);
    } else {
      try { root = await canonicalWorkspace(suppliedRoot, config.allowedRoots); }
      catch (error) { fail(`--root is not an allowed workspace root: ${String(error)}`); }
      out(`  ok   root is allowed: ${root}`);
    }

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

    // ---- 2. the workspace this v5 session will act in --------------------------------------
    //
    // Minted through `AdmittedWorkspaceService.open`, which is the only route to a workspace the
    // gateway has: it canonicalises the path against `allowedRoots`, opens it on DevSpace, and
    // stamps the calling tuple onto the row. Passing the v5 caller is the whole fix — the row
    // comes out owned by the session the delegation is about to bind, so `sameAuthority` admits it
    // at execution instead of refusing after a slot is gone.
    //
    // A workspace row is not authority. It grants nothing on its own: only the tuple that owns it
    // can name it, and naming it does nothing until a delegation the human issues and configures
    // binds it. So minting one before the grants does not widen anything, and a failure after this
    // point leaves a workspace and no authority at all.
    let workspaceId = suppliedWorkspaceId;
    if (!workspaceId) {
      if (!process.env.DEVSPACE_OAUTH_OWNER_TOKEN) {
        fail('DEVSPACE_OAUTH_OWNER_TOKEN is not set, so a workspace cannot be opened. It is the '
          + 'loopback secret the running DevSpace and gateway already share — set it in this '
          + 'shell from the same file the stack was started with.');
      }
      out('');
      out('minting the v5-owned workspace');
      const { bootstrapPrivateGateway } = require(join(REPO, 'dist/private-runtime.js'));
      const { AdmittedWorkspaceService } = require(join(REPO, 'dist/admitted-workspace.js'));
      const { DevspaceRepositoryInspectionBackend } =
        require(join(REPO, 'dist/repository-inspection.js'));
      let runtime;
      try { runtime = await bootstrapPrivateGateway(config, { env: process.env }); }
      catch (error) { fail(`DevSpace is not reachable: ${String(error)}`); }
      closeRuntime = () => runtime.close();
      const workspaces = new AdmittedWorkspaceService({
        store,
        executor: runtime.executor,
        inspection: new DevspaceRepositoryInspectionBackend(runtime.executor),
        allowedRoots: config.allowedRoots,
      });
      try { ({ workspaceId } = await workspaces.open(caller, root)); }
      catch (error) { fail(`the workspace could not be opened: ${String(error)}`); }
      out(`  ok   workspace ${workspaceId}`);
    }

    // Read back from the durable row, not from what `open` returned. What the delegation binds is
    // a row, and the only fact that matters about it is who owns it.
    const bound = store.getWorkspace(workspaceId);
    if (!bound) fail('the workspace did not persist');
    if (bound.ownerId !== caller.ownerId
      || bound.sessionId !== caller.sessionId
      || bound.adapterId !== caller.adapterId) {
      fail('the stored workspace is not owned by the v5 session; refusing to bind a grant to it');
    }
    if (bound.canonicalRoot !== root) {
      fail(`the stored workspace root ${bound.canonicalRoot} is not ${root}`);
    }
    out(`  ok   owned by ${caller.adapterId} / ${caller.sessionId}`);

    // ---- 3. issue the delegation -----------------------------------------------------------
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

    // ---- 4. verify it reads back exactly ---------------------------------------------------
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

    // ---- 5. issue the matching lease, still writing nothing to configuration -------------
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

    // ---- 6. ONE atomic write naming BOTH grants ------------------------------------------
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

    // ---- 7. the composition, asserted ------------------------------------------------------
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
    out(`  owned by    ${caller.adapterId} / ${caller.sessionId}`);
    out(`  branch      ${branch} @ ${headSha.slice(0, 12)}`);
    out('');
    out('Both grants are now named in configuration. Restart WAG so it re-reads them.');
    out('To stop everything at any time: npm run lease:stop');
    return 0;
  } finally {
    if (typeof closeRuntime === 'function') await closeRuntime().catch(() => undefined);
    store.close();
  }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
