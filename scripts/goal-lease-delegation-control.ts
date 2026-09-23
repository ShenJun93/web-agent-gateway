/**
 * Human-only Goal Lease issuance control for the direct MCP development lane.
 *
 * The file name deliberately contains "delegation-control": the applied human-presence guard
 * refuses running this script with --issue from an agent. Read-only inspection and revocation
 * remain available. Issuance inserts one immutable lease row only; naming goalLeaseId in local
 * configuration remains a separate human act.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { SqliteDurableStore } from '../src/durable-store.js';
import {
  MAX_LEASE_WINDOW_MS,
  validateBindings,
  type GoalLeaseBindings,
} from '../src/goal-lease.js';

const argv = process.argv.slice(2);

function out(value = ''): void {
  process.stdout.write(value + '\n');
}

function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(flag + ' needs a value');
  return value;
}

function required(flag: string): string {
  const value = argValue(flag);
  if (value === undefined) throw new Error(flag + ' is required');
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function absolute(flag: string): string {
  const value = required(flag);
  if (!isAbsolute(value)) throw new Error(flag + ' must be an absolute path');
  return value;
}

function ttlMs(): number {
  const minutes = Number(argValue('--ttl-minutes') ?? '60');
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('--ttl-minutes must be a positive number');
  }
  const value = Math.round(minutes * 60_000);
  if (value > MAX_LEASE_WINDOW_MS) {
    throw new Error('--ttl-minutes exceeds the Goal Lease maximum window');
  }
  return value;
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git.exe', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      'git failed (' + String(result.status) + ') in ' + root + ': '
      + (result.stderr ?? '').trim(),
    );
  }
  return (result.stdout ?? '').trim();
}

interface IssuePlan {
  readonly version: 'wag.goal-lease-human-issue.v1';
  readonly statePath: string;
  readonly bindingsPath: string;
  readonly bindingsSha256: string;
  readonly ttlMs: number;
  readonly bindings: GoalLeaseBindings;
}

function buildIssuePlan(store: SqliteDurableStore): { plan: IssuePlan; digest: string } {
  const statePath = absolute('--state');
  const bindingsPath = absolute('--bindings');
  const bindingsText = readFileSync(bindingsPath, 'utf8');

  let bindings: GoalLeaseBindings;
  try {
    bindings = JSON.parse(bindingsText) as GoalLeaseBindings;
  } catch {
    throw new Error('--bindings is not valid JSON');
  }

  const malformed = validateBindings(bindings);
  if (malformed) throw new Error('Goal Lease bindings are malformed: ' + malformed);

  for (const root of bindings.workspaceRoots) {
    if (!isAbsolute(root)) throw new Error('workspaceRoot is not absolute: ' + root);
    const canonical = realpathSync.native(root);
    if (canonical !== root) {
      throw new Error('workspaceRoot is not canonical: ' + root + '; use ' + canonical);
    }
  }

  for (const sessionId of bindings.admittedSessions) {
    const session = store.getAdapterSession(sessionId);
    if (!session) throw new Error('no durable admitted session ' + sessionId);
    if (!bindings.admittedAdapters.includes(session.adapterId)) {
      throw new Error(
        'session ' + sessionId + ' belongs to adapter ' + session.adapterId
        + ', which is not admitted',
      );
    }
  }

  if (bindings.commitSemantics === 'commit-to-bound-branch') {
    if (bindings.commitBindings !== undefined) {
      for (const binding of bindings.commitBindings) {
        const root = realpathSync.native(binding.workspaceRoot);
        const branch = git(root, ['branch', '--show-current']);
        const headSha = git(root, ['rev-parse', 'HEAD']);
        if (branch !== binding.branch) {
          throw new Error(
            'commit binding branch drift for ' + binding.workspaceRoot
            + ': expected ' + binding.branch + ', found ' + branch,
          );
        }
        if (headSha !== binding.headSha) {
          throw new Error(
            'commit binding HEAD drift for ' + binding.workspaceRoot
            + ': expected ' + binding.headSha + ', found ' + headSha,
          );
        }
      }
    } else {
      const legacy = bindings as GoalLeaseBindings & { branch?: string; headSha?: string };
      if (bindings.workspaceRoots.length !== 1 || !legacy.branch || !legacy.headSha) {
        throw new Error('legacy commit binding must name one workspace root, branch and HEAD');
      }
      const root = realpathSync.native(bindings.workspaceRoots[0]!);
      const branch = git(root, ['branch', '--show-current']);
      const headSha = git(root, ['rev-parse', 'HEAD']);
      if (branch !== legacy.branch || headSha !== legacy.headSha) {
        throw new Error(
          'legacy commit binding drift: expected ' + legacy.branch + '@' + legacy.headSha
          + ', found ' + branch + '@' + headSha,
        );
      }
    }
  }

  const plan: IssuePlan = {
    version: 'wag.goal-lease-human-issue.v1',
    statePath,
    bindingsPath,
    bindingsSha256: sha256(bindingsText),
    ttlMs: ttlMs(),
    bindings,
  };
  return { plan, digest: sha256(JSON.stringify(plan)) };
}

function printLease(store: SqliteDurableStore, leaseId: string): number {
  const row = store.getGoalLeaseRow(leaseId);
  if (!row) {
    out('no Goal Lease ' + leaseId);
    return 1;
  }
  const now = Date.now();
  const state = row.revokedAt !== undefined
    ? 'REVOKED'
    : now < row.notBefore
      ? 'NOT_YET_VALID'
      : now >= row.expiresAt
        ? 'EXPIRED'
        : 'ACTIVE';
  out(JSON.stringify({
    leaseId: row.leaseId,
    state,
    createdAt: row.createdAt,
    notBefore: row.notBefore,
    expiresAt: row.expiresAt,
    ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
    bindings: JSON.parse(row.bindings),
  }, null, 2));
  return 0;
}

async function main(): Promise<number> {
  if (argv.length === 0 || argv.includes('--help')) {
    out('Human Goal Lease control');
    out('');
    out('  --list --state <absolute sqlite path>');
    out('  --show <lease_...> --state <absolute sqlite path>');
    out('  --revoke <lease_...> --state <absolute sqlite path>');
    out('  --issue --state <absolute sqlite path> --bindings <absolute json path>');
    out('          [--ttl-minutes <n>]');
    out('');
    out('Issuance requires an interactive TTY and exact ISSUE <sha256> confirmation.');
    out('It inserts a lease row only; activating goalLeaseId remains a separate human edit.');
    return 0;
  }

  const store = new SqliteDurableStore(absolute('--state'));
  try {
    if (argv.includes('--list')) {
      for (const id of store.listGoalLeaseIds()) out(id);
      return 0;
    }

    const showId = argValue('--show');
    if (showId !== undefined) return printLease(store, showId);

    const revokeId = argValue('--revoke');
    if (revokeId !== undefined) {
      const changed = store.revokeGoalLease(revokeId, Date.now());
      out(changed ? 'revoked ' + revokeId : 'nothing to revoke: ' + revokeId);
      return 0;
    }

    if (!argv.includes('--issue')) throw new Error('nothing to do; see --help');
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'Goal Lease issuance requires an interactive TTY human confirmation; automation is refused',
      );
    }

    const measured = buildIssuePlan(store);
    out('=== HUMAN GOAL LEASE ISSUE PLAN ===');
    out(JSON.stringify(measured.plan, null, 2));
    out('GOAL_LEASE_ISSUE_PLAN_SHA256=' + measured.digest);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer = '';
    try {
      answer = await rl.question(
        'Type ISSUE ' + measured.digest + ' to insert this immutable Goal Lease: ',
      );
    } finally {
      rl.close();
    }
    if (answer.trim() !== 'ISSUE ' + measured.digest) {
      throw new Error('human confirmation did not match the reviewed Goal Lease plan');
    }

    const fresh = buildIssuePlan(store);
    if (fresh.digest !== measured.digest) {
      throw new Error(
        'Goal Lease plan changed while awaiting confirmation: reviewed '
        + measured.digest + ', current ' + fresh.digest,
      );
    }

    const createdAt = Date.now();
    const leaseId = 'lease_' + createdAt.toString(36) + '_' + randomBytes(4).toString('hex');
    store.insertGoalLease({
      leaseId,
      createdAt,
      notBefore: createdAt - 1_000,
      expiresAt: createdAt + fresh.plan.ttlMs,
      bindings: JSON.stringify(fresh.plan.bindings),
    });

    const row = store.getGoalLeaseRow(leaseId);
    if (!row || row.bindings !== JSON.stringify(fresh.plan.bindings)) {
      throw new Error('Goal Lease did not read back exactly after insertion');
    }

    out('');
    out('ISSUED_GOAL_LEASE_ID=' + leaseId);
    out('EXPIRES_AT=' + String(row.expiresAt));
    out('PLAN_SHA256=' + fresh.digest);
    out('INERT_UNTIL_NAMED_IN_CONFIG=True');
    return 0;
  } finally {
    store.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
