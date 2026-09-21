import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DEVSPACE_TEST_OWNER_TOKEN, startPinnedDevspace } from './devspace-fixture.js';

/**
 * Autonomous Goal Lease execution, end to end, with no human gesture of any kind (ADR-0028).
 *
 * This is deliberately the *production assembly*: the built CLI spawned as a separate process
 * over a real stdio transport, a real DevSpace, a real SQLite store, the real coordinator and the
 * real filesystem backend. Nothing is stubbed and the harness lane is not involved.
 *
 * ## Why this surface
 *
 * A lease removes the operator's Approve. Whether it removes *Run* depends on where the proposal
 * comes from, and Run is a browser-adapter concept — the act of turning an untrusted page's text
 * into a proposal. On the stdio surface there is no page and no Run: the caller proposes
 * directly. So this is where a lease produces genuinely gesture-free execution, and it is the
 * honest place to prove the claim.
 *
 * The second test is the more important one. It runs the identical assembly with no lease and
 * shows the proposal sitting untouched, because a mechanism that quietly changes the default is
 * worse than no mechanism.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = join(repoRoot, 'dist', 'cli.js');

const BEFORE = 'export const ticketId = (raw) => String(raw).trim();\n';
const AFTER = 'export const ticketId = (raw) => String(raw ?? "").trim();\n';
const LEASE_ID = 'lease_e2e_acceptance';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function parse<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const text = content.find((entry) => entry.type === 'text')?.text ?? '';
  return JSON.parse(text) as T;
}

/** Stands up the production assembly. `lease` decides whether the config names one. */
async function gateway(t: { after(fn: () => void | Promise<void>): void }, options: { lease: boolean }) {
  const temp = await mkdtemp(join(tmpdir(), 'wag-lease-e2e-'));
  const workspaceRoot = join(temp, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'ticket-id.js'), BEFORE, 'utf8');

  const devspace = await startPinnedDevspace({ workspaceRoot });

  const statePath = join(temp, 'control-plane.sqlite');
  const configPath = join(temp, 'private.json');
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [workspaceRoot],
    devspace: { baseUrl: devspace.baseUrl, resourceUrl: devspace.resourceUrl },
    verifyProfiles: { unit: { argv: ['npm', 'test'], timeoutMs: 30_000, maxOutputTokens: 4_000 } },
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath,
        ownerId: 'local.private.stdio',
        ...(options.lease ? { goalLeaseId: LEASE_ID } : {}),
      },
      gitCommit: {},
    },
  }), 'utf8');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [builtCli, 'serve-stdio', '--config', configPath],
    env: { ...getDefaultEnvironment(), DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
    stderr: 'pipe',
    cwd: repoRoot,
  });
  const client = new Client({ name: 'goal-lease-e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  // ONE hook, registered after everything, in dependency order. `node:test` runs `t.after` in
  // registration order, so a directory removal registered earlier raced the child gateway's own
  // open SQLite handle and failed EBUSY on Windows — the trap this repo's gate skill warns about.
  t.after(async () => {
    await client.close().catch(() => undefined);
    await devspace.stop().catch(() => undefined);
    // The child needs a moment to release the store after its transport closes.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  });

  return { client, statePath, workspaceRoot, temp, pid: transport.pid };
}

/** Reads the durable store the gateway is using, read-only, without going through the gateway. */
function readStore<T>(statePath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

async function waitFor<T>(what: string, poll: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = poll();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('a bounded Goal Lease executes a real mutation with no Run and no Approve', async (t) => {
  const g = await gateway(t, { lease: true });
  assert.ok(g.pid, 'the gateway runs as a separate process');

  const { workspaceId } = parse<{ workspaceId: string }>(
    await g.client.callTool({ name: 'workspace.open', arguments: { path: g.workspaceRoot } }),
  );

  // The lease is granted out of band, by something that is not the gateway and not the caller —
  // here the test, standing in for the human. It is bound to the session the gateway minted,
  // which is why it is created after the workspace exists rather than before: a lease names an
  // exact session, and nothing may issue itself one.
  const workspace = readStore(g.statePath, (db) =>
    db.prepare('SELECT session_id, adapter_id, canonical_root FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as { session_id: string; adapter_id: string; canonical_root: string });

  const now = Date.now();
  const write = new DatabaseSync(g.statePath);
  try {
    write.prepare(`INSERT INTO goal_leases (lease_id, created_at, not_before, expires_at, bindings)
      VALUES (?, ?, ?, ?, ?)`).run(LEASE_ID, now, now, now + 10 * 60_000, JSON.stringify({
      workspaceRoots: [workspace.canonical_root],
      allowedTools: ['mutation.preview'],
      pathPatterns: ['*.js'],
      maxFiles: 2,
      maxBytes: 10_000,
      maxDiffBytes: 5_000,
      admittedSessions: [workspace.session_id],
      admittedAdapters: [workspace.adapter_id],
      commitSemantics: 'none',
    }));
  } finally { write.close(); }

  // Propose. This is the only call made, and it is a proposal — not an approval.
  const preview = parse<{ status: string; mutationId: string; resultSha256: string }>(
    await g.client.callTool({
      name: 'mutation.preview',
      arguments: {
        workspace_id: workspaceId, path: 'ticket-id.js', base_sha256: sha256(BEFORE),
        before: 'String(raw).trim()', after: 'String(raw ?? "").trim()',
      },
    }),
  );
  assert.equal(preview.status, 'approval_required');
  assert.match(preview.mutationId, /^mut_/);
  assert.equal(await readFile(join(g.workspaceRoot, 'ticket-id.js'), 'utf8'), BEFORE,
    'proposing alone still changes nothing');

  // Nothing else is called. The policy admits, on its own, and executes.
  const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN', 'REJECTED', 'EXPIRED']);
  const finalState = await waitFor('the policy to admit and execute', () =>
    readStore(g.statePath, (db) => {
      const row = db.prepare('SELECT state FROM mutations WHERE mutation_id = ?')
        .get(preview.mutationId) as { state: string } | undefined;
      // QUEUED and EXECUTING are transients on the way through; waiting only for "not pending"
      // caught EXECUTING and reported a failure for a run that was working correctly.
      return row && TERMINAL.has(row.state) ? row.state : undefined;
    }));
  assert.equal(finalState, 'SUCCEEDED', 'the mutation executed');

  // The effect is real, on disk, and is the reviewed content.
  assert.equal(await readFile(join(g.workspaceRoot, 'ticket-id.js'), 'utf8'), AFTER);

  // And the durable record says which authority caused it.
  const authority = readStore(g.statePath, (db) =>
    db.prepare('SELECT authority, lease_id FROM mutation_authority WHERE mutation_id = ?')
      .get(preview.mutationId) as { authority: string; lease_id: string } | undefined);
  assert.equal(authority?.authority, 'POLICY_APPROVED');
  assert.equal(authority?.lease_id, LEASE_ID);

  // No human approval is recorded anywhere in this store.
  const humanCount = readStore(g.statePath, (db) =>
    (db.prepare("SELECT COUNT(*) AS n FROM mutation_authority WHERE authority = 'HUMAN_APPROVED'")
      .get() as { n: number }).n);
  assert.equal(Number(humanCount), 0, 'no human approved anything in this run');
});

test('with no lease the identical assembly changes nothing without a human', async (t) => {
  // The control. Same gateway, same call, no `goalLeaseId` — which is every existing deployment.
  const g = await gateway(t, { lease: false });

  const { workspaceId } = parse<{ workspaceId: string }>(
    await g.client.callTool({ name: 'workspace.open', arguments: { path: g.workspaceRoot } }),
  );
  const preview = parse<{ status: string; mutationId: string }>(
    await g.client.callTool({
      name: 'mutation.preview',
      arguments: {
        workspace_id: workspaceId, path: 'ticket-id.js', base_sha256: sha256(BEFORE),
        before: 'String(raw).trim()', after: 'String(raw ?? "").trim()',
      },
    }),
  );
  assert.equal(preview.status, 'approval_required');

  // Long enough that an admission pass would have fired several times if one existed.
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  const state = readStore(g.statePath, (db) =>
    (db.prepare('SELECT state FROM mutations WHERE mutation_id = ?')
      .get(preview.mutationId) as { state: string }).state);
  assert.equal(state, 'PENDING_APPROVAL', 'it is still waiting for a human, as it always was');
  assert.equal(await readFile(join(g.workspaceRoot, 'ticket-id.js'), 'utf8'), BEFORE,
    'and nothing reached disk');

  const authority = readStore(g.statePath, (db) =>
    db.prepare('SELECT authority FROM mutation_authority WHERE mutation_id = ?')
      .get(preview.mutationId));
  assert.equal(authority, undefined, 'admitted by neither, so it carries no authority at all');
});
