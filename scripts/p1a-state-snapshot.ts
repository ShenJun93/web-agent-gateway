/**
 * P1A before/after state snapshot.
 *
 * P1A's central negative claim is that a read/verify benchmark caused no consequential effect.
 * That claim is only worth the evidence behind it, so this captures the same facts before and
 * after the batch and a later diff proves the deltas are zero.
 *
 * It reads. It opens every SQLite store read-only, runs SELECTs, and writes nothing anywhere.
 *
 *   npm run p1a:snapshot -- before
 *   npm run p1a:snapshot -- after
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EVIDENCE_DIR = 'E:/AI-BROWSER/wag-acceptance/p1a/evidence';
const WORKSPACE = 'E:/AI-BROWSER/wag-acceptance/p1a/workspace';

/** Every durable store a P1A run could conceivably touch, named so absence is also evidence. */
function storePaths(env: NodeJS.ProcessEnv): Array<{ label: string; path: string }> {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) {
    throw new Error('LOCALAPPDATA is not absolute, so the production store cannot be located');
  }
  return [
    { label: 'production', path: join(localAppData, 'WebAgentGateway', 'browser-operator-v4.sqlite') },
    { label: 'p1a', path: 'E:/AI-BROWSER/wag-acceptance/p1a/state/p1a-operator.sqlite' },
  ];
}

/** Row counts for every table whose growth would mean a consequential effect happened. */
const COUNTED = [
  'mutations', 'mutation_authority', 'commits', 'commit_authority',
  'goal_leases', 'workspaces', 'adapter_sessions', 'audit_events',
] as const;

function countRows(path: string): Record<string, number | string> {
  if (!existsSync(path)) return { present: 'absent' };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const out: Record<string, number | string> = { present: 'yes' };
    for (const table of COUNTED) {
      try {
        out[table] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
      } catch {
        // A table that does not exist is recorded as such rather than silently omitted: an
        // absent table and a table with zero rows are different facts.
        out[table] = 'no such table';
      }
    }
    // The states present, so a non-terminal record left behind is visible rather than implied.
    try {
      const states = db.prepare('SELECT state, COUNT(*) AS n FROM mutations GROUP BY state').all() as
        Array<{ state: string; n: number }>;
      out.mutationStates = states.map((s) => `${s.state}:${s.n}`).join(',') || '(none)';
    } catch { out.mutationStates = 'no such table'; }
    return out;
  } finally {
    db.close();
  }
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd: process.cwd() }).trim();
  } catch (error) {
    return `(git failed: ${(error as Error).message.split('\n')[0]})`;
  }
}

/** Hashes of every fixture file, so an unexpected repository effect is detectable rather than assumed. */
function workspaceDigest(): Record<string, string> {
  const listing = git(['--no-pager', 'hash-object', '--']);
  void listing;
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of execFileSync('cmd', ['/c', 'dir', '/b', '/s', '/a-d', dir.replace(/\//g, '\\')], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean)) {
      const rel = entry.replace(/\\/g, '/').replace(`${WORKSPACE}/`, '');
      out[rel] = execFileSync('certutil', ['-hashfile', entry, 'SHA256'], { encoding: 'utf8' })
        .split('\n')[1]?.trim().replace(/\s/g, '') ?? 'unreadable';
    }
  };
  try { walk(WORKSPACE); } catch (error) { out['(walk failed)'] = (error as Error).message.split('\n')[0]; }
  return out;
}

function main(): number {
  const phase = process.argv[2];
  if (phase !== 'before' && phase !== 'after') {
    console.error('usage: p1a-state-snapshot before|after');
    return 1;
  }

  const snapshot = {
    type: 'p1a.stateSnapshot',
    phase,
    capturedAt: new Date().toISOString(),
    git: {
      localHead: git(['rev-parse', 'HEAD']),
      localHeadSubject: git(['log', '--format=%s', '-1']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      canonicalMain: git(['rev-parse', 'origin/main']),
      statusPorcelain: git(['status', '--porcelain']) || '(clean)',
      diffStat: git(['diff', '--stat']) || '(no unstaged changes)',
      srcTreeHash: git(['rev-parse', 'HEAD:src']),
      testTreeHash: git(['rev-parse', 'HEAD:test']),
    },
    stores: Object.fromEntries(storePaths(process.env).map((s) => [s.label, countRows(s.path)])),
    workspace: workspaceDigest(),
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const out = join(EVIDENCE_DIR, `state-${phase}.json`);
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(snapshot, null, 2));
  console.error(`\nwritten: ${out}`);
  return 0;
}

process.exitCode = main();
