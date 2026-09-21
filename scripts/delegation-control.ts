/**
 * The local controller for Goal UI Delegations (ADR-0029) — **run by a human, never by Claude**.
 *
 *   npx tsx scripts/delegation-control.ts --sessions
 *   npx tsx scripts/delegation-control.ts --workspaces
 *   npx tsx scripts/delegation-control.ts --show <uidel_...>
 *   npx tsx scripts/delegation-control.ts --issue --goal <id> --session <id> --workspace <ws_...> \
 *       --tools repo.search,file.read --origin https://chatgpt.com --max-actions 20 --ttl-minutes 60
 *   npx tsx scripts/delegation-control.ts --renew <uidel_...> --ttl-minutes 60
 *   npx tsx scripts/delegation-control.ts --revoke <uidel_...>
 *
 * ## Why this file exists, and why running it is not a formality
 *
 * `human-presence-boundary.md` says `UI_DELEGATION_ISSUANCE = HUMAN_ONLY_AND_OUT_OF_BAND`, and
 * that clause is what keeps the whole design from being circular: an authority Claude may *use*
 * must not be one Claude may *mint*. Claude wrote this script. Claude must not run it.
 *
 * That is a rule, not a mechanism, and it is worth being exact about which is which. Code cannot
 * tell whose hands are on the keyboard — `createControllerPlaneKey` is called two lines below, and
 * anything executing in this process can call it. What the code *does* enforce is narrower and
 * still useful: nothing on the browser path can reach this module or the store methods behind it,
 * because the dispatch plane is handed a port object that lacks them at runtime. ADR-0019 already
 * places a same-user adversary outside the containment claim, and this is inside that boundary.
 *
 * ## The bootstrap order, which is not obvious
 *
 * A delegation binds a `sessionId`, and WAG mints that when the extension connects — so the
 * session must exist before the delegation can be issued, and the delegation must be named in
 * configuration before it does anything. That means:
 *
 *   1. name a placeholder id in `repositoryEngineering.mutation.goalUiDelegationId` and start WAG.
 *      A placeholder names no row, so every delegated dispatch is refused `DELEGATION_NOT_FOUND`;
 *      the v5 surface is up but authorises nothing.
 *   2. connect the extension. WAG mints the v5 session.
 *   3. `--sessions` here, to find it; `--issue` to bind a delegation to it.
 *   4. put the printed id in the config and restart WAG.
 *
 * The reconnect in step 4 returns the *same* session id, because a session is keyed by the
 * correlation the extension holds in `chrome.storage.session`, which survives a WAG restart. An
 * extension *reload* does not survive — it re-mints the correlation, so the delegation stops
 * matching and must be reissued. That is the binding working, not a bug.
 */
import { isAbsolute, join } from 'node:path';
import { BROWSER_DELEGATION_ADAPTER_ID } from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  UiDelegationControlPlane,
  createControllerPlaneKey,
} from '../src/goal-ui-delegation-control.js';
import { MAX_DELEGATION_WINDOW_MS } from '../src/goal-ui-delegation.js';

/** The identity every delegation issued here is bound to. Bindings must name it, and do. */
const CONTROLLER_ID = 'local.operator.cli';

function statePath(): string {
  const override = argValue('--state');
  if (override) {
    if (!isAbsolute(override)) throw new Error('--state must be an absolute path');
    return override;
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA is required (or pass --state <absolute path>)');
  return join(localAppData, 'WebAgentGateway', 'browser-operator-v4.sqlite');
}

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}
function required(flag: string): string {
  const value = argValue(flag);
  if (value === undefined) throw new Error(`${flag} is required`);
  return value;
}

function out(line = ''): void { process.stdout.write(`${line}\n`); }

function describeWindow(row: { notBefore: number; expiresAt: number; revokedAt?: number; supersededBy?: string }): string {
  const now = Date.now();
  if (row.revokedAt !== undefined) return `REVOKED at ${new Date(row.revokedAt).toISOString()}`;
  if (row.supersededBy !== undefined) return `SUPERSEDED by ${row.supersededBy}`;
  if (now < row.notBefore) return `not yet active (starts ${new Date(row.notBefore).toISOString()})`;
  if (now > row.expiresAt) return `EXPIRED at ${new Date(row.expiresAt).toISOString()}`;
  return `active, expires ${new Date(row.expiresAt).toISOString()} (${Math.round((row.expiresAt - now) / 60000)} min left)`;
}

function main(): number {
  if (argv.length === 0 || argv.includes('--help')) {
    out('Goal UI Delegation control — issue, renew and revoke. Run by a human.');
    out('');
    out('  --sessions                       list admitted v5 sessions (find the one to bind)');
    out('  --workspaces                     list open workspaces');
    out('  --show <uidel_...>               print one delegation and its state');
    out('  --issue --goal <id> --session <id> --workspace <ws_...>');
    out('          --tools a,b --origin <https origin> --max-actions <n> --ttl-minutes <n>');
    out('  --renew <uidel_...> --ttl-minutes <n>');
    out('  --revoke <uidel_...>');
    out('');
    out('  --state <path>                   the WAG store (default: LOCALAPPDATA store)');
    out('');
    out('Issuing does not enable anything on its own: the printed id must be named in');
    out('repositoryEngineering.mutation.goalUiDelegationId and WAG restarted. That second');
    out('step is a human edit to a local config file, deliberately.');
    return 0;
  }

  const store = new SqliteDurableStore(statePath());
  try {
    if (argv.includes('--sessions')) {
      const sessions = store.listAdapterSessions(BROWSER_DELEGATION_ADAPTER_ID);
      if (sessions.length === 0) {
        out(`no ${BROWSER_DELEGATION_ADAPTER_ID} sessions yet.`);
        out('Connect the extension first — the session is minted when it binds.');
        return 1;
      }
      out(`${BROWSER_DELEGATION_ADAPTER_ID} sessions, newest first:`);
      for (const session of sessions) {
        out(`  ${session.sessionId}   admitted ${new Date(session.createdAt).toISOString()}`);
      }
      return 0;
    }

    if (argv.includes('--workspaces')) {
      const workspaces = store.listWorkspacesForOwner(store.getOrCreateLocalPrincipal(Date.now()).ownerId);
      if (workspaces.length === 0) { out('no open workspaces.'); return 1; }
      for (const workspace of workspaces) {
        out(`  ${workspace.workspaceId}   ${workspace.canonicalRoot}`);
      }
      return 0;
    }

    const showId = argValue('--show');
    if (showId !== undefined) {
      const row = store.getUiDelegationRow(showId);
      if (!row) { out(`no delegation ${showId}`); return 1; }
      out(`delegation ${row.delegationId}`);
      out(`  goal        ${row.goalId}`);
      out(`  controller  ${row.controllerId}`);
      out(`  state       ${describeWindow(row)}`);
      out(`  actions     ${store.countDelegationClaims(row.delegationId)} claimed of `
        + `${(JSON.parse(row.bindings) as { maxActions: number }).maxActions}`);
      out(`  bindings    ${row.bindings}`);
      return 0;
    }

    const revokeId = argValue('--revoke');
    if (revokeId !== undefined) {
      const control = new UiDelegationControlPlane({
        store, key: createControllerPlaneKey(CONTROLLER_ID),
      });
      const revoked = control.revoke(revokeId);
      out(revoked
        ? `revoked ${revokeId}. Every dispatch under it is refused from the next call.`
        : `nothing to revoke: ${revokeId} was already revoked, or does not exist.`);
      out('Revocation is one-way. A revoked delegation can never be renewed back into life.');
      return 0;
    }

    const ttlMinutes = Number(argValue('--ttl-minutes') ?? '60');
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error('--ttl-minutes must be positive');
    const ttlMs = Math.round(ttlMinutes * 60_000);
    if (ttlMs > MAX_DELEGATION_WINDOW_MS) {
      throw new Error(`--ttl-minutes may not exceed ${MAX_DELEGATION_WINDOW_MS / 60_000}`);
    }

    const renewId = argValue('--renew');
    if (renewId !== undefined) {
      const existing = store.getUiDelegationRow(renewId);
      if (!existing) { out(`no delegation ${renewId}`); return 1; }
      const control = new UiDelegationControlPlane({
        store, key: createControllerPlaneKey(CONTROLLER_ID),
      });
      // The successor carries the predecessor's bindings verbatim. Renewal extends time and resets
      // the budget; it is not a place to widen scope, and taking new bindings here would make it
      // one — a "renew" that quietly changed the allowed tools is exactly the edit this design
      // says cannot happen.
      const outcome = control.renew({
        delegationId: renewId,
        goalId: existing.goalId,
        bindings: JSON.parse(existing.bindings),
        ttlMs,
      });
      if (!outcome.ok) { out(`refused: ${outcome.code} — ${outcome.detail}`); return 1; }
      out(`renewed. ${outcome.superseded} is superseded and authorises nothing.`);
      out(`successor   ${outcome.delegationId}`);
      out('');
      out('Name the successor in goalUiDelegationId and restart WAG. Until you do, the');
      out('predecessor is dead and the successor is inert — delegated Run is off in between.');
      return 0;
    }

    if (argv.includes('--issue')) {
      const sessionId = required('--session');
      const session = store.getAdapterSession(sessionId);
      if (!session) throw new Error(`no admitted session ${sessionId} — run --sessions`);
      if (session.adapterId !== BROWSER_DELEGATION_ADAPTER_ID) {
        throw new Error(`session ${sessionId} is ${session.adapterId}, not ${BROWSER_DELEGATION_ADAPTER_ID}`);
      }
      const workspaceId = required('--workspace');
      const tools = required('--tools').split(',').map((t) => t.trim()).filter(Boolean);
      if (tools.length === 0) throw new Error('--tools needs at least one tool name');
      const origins = required('--origin').split(',').map((o) => o.trim()).filter(Boolean);
      const maxActions = Number(required('--max-actions'));
      if (!Number.isInteger(maxActions) || maxActions <= 0) {
        throw new Error('--max-actions must be a positive integer');
      }

      const control = new UiDelegationControlPlane({
        store, key: createControllerPlaneKey(CONTROLLER_ID),
      });
      const goalId = required('--goal');
      const { delegationId } = control.issue({
        goalId,
        ttlMs,
        bindings: {
          goalId,
          controllerId: CONTROLLER_ID,
          allowedOrigins: origins,
          allowedTools: tools,
          workspaceId,
          sessionId,
          adapterId: BROWSER_DELEGATION_ADAPTER_ID,
          maxActions,
        },
      });
      out(`issued ${delegationId}`);
      out(`  goal        ${goalId}`);
      out(`  session     ${sessionId}`);
      out(`  workspace   ${workspaceId}`);
      out(`  tools       ${tools.join(', ')}`);
      out(`  origins     ${origins.join(', ')}`);
      out(`  budget      ${maxActions} dispatches, total, across the whole delegation`);
      out(`  window      ${ttlMinutes} minutes`);
      out('');
      out('NOTHING IS ENABLED YET. This row is inert until it is named in configuration:');
      out('');
      out(`    "goalUiDelegationId": "${delegationId}"`);
      out('');
      out('under repositoryEngineering.mutation, then restart WAG. That edit is the second');
      out('human act, and it is what makes issuance and activation two separate decisions.');
      out('');
      out('It lifts Run only. Approve is unchanged: an effect still needs the operator, or a');
      out('Goal Lease that admits it. `npm run lease:stop` halts it without revoking it.');
      return 0;
    }

    out('nothing to do — see --help');
    return 2;
  } finally {
    store.close();
  }
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
