/**
 * The harness test-authority lane.
 *
 * Iterating on WAG end to end used to cost the operator two real gestures per attempt — Run in the
 * side panel, then approve on the review server. That is correct for production and unbearable for
 * debugging, so this provides a lane where the *equivalents* of both can be driven by a script.
 *
 * It is deliberately **not** a mode of the production path. There is no `if (TEST_MODE)` anywhere
 * in `operator-server.ts` or in the coordinators, and nothing in `src/browser-operator-runtime.ts`
 * imports this file — `test/harness-authority.test.ts` asserts both. What this is instead: a
 * second, separate client of the same coordinator classes, which can only ever be holding a store
 * it created itself.
 *
 * That last property is what makes it safe, and it is structural rather than promised:
 *
 *   - a lane is created fresh, never opened. `createHarnessLane` refuses a directory that already
 *     exists, so an existing store — production's included — can never be adopted or retro-marked;
 *   - the lane writes a marker naming its own id, store and fixture root, and every later
 *     operation re-reads it and refuses on any mismatch;
 *   - the production store path is refused by name, belt and braces;
 *   - the lane root must be outside this repository and outside the production state directory, so
 *     it cannot mutate the canonical repository or a real user project;
 *   - approval re-derives the record's workspace and refuses unless its canonical root is inside
 *     this lane's fixture. A record belonging to any other workspace is refused even if its id is
 *     handed over directly;
 *   - it is off unless `WAG_HARNESS_LANE=1` *and* the caller passes the exact lane literal.
 *
 * Nothing here can reach a production record, because it can never hold the store one lives in.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createGatewayCallerContext } from './caller-context.js';
import { SqliteDurableStore } from './durable-store.js';
import { DurableMutationCoordinator } from './durable-mutation.js';
import type { FileMutationBackend } from './file-mutation-backend.js';

/** The literal a caller must pass. A boolean would be easy to set by accident. */
export const HARNESS_LANE = 'harness-test-only' as const;

const MARKER_FILE = 'harness-lane.json';
const STORE_FILE = 'harness-lane.sqlite';
const FIXTURE_DIR = 'fixture';
const BACKEND_KIND = 'harness-lane-fs';

export interface HarnessLane {
  readonly laneId: string;
  readonly fixtureRoot: string;
  /**
   * The Run equivalent: submits a proposal to WAG, exactly as pressing Run does. It creates a
   * durable record awaiting review and causes no effect on its own.
   */
  propose(input: { path: string; before: string; after: string }): Promise<{ mutationId: string; resultSha256: string }>;
  /** The operator-approval equivalent: the only thing that causes an effect. */
  approve(mutationId: string): Promise<boolean>;
  reject(mutationId: string): boolean;
  pending(): Array<{ mutationId: string; path: string }>;
  readFixture(path: string): Promise<string>;
  writeFixture(path: string, content: string): Promise<void>;
  close(): void;
  /** Removes the whole lane, including its store and fixture. */
  destroy(): Promise<void>;
}

interface LaneMarker {
  laneId: string;
  lane: typeof HARNESS_LANE;
  storePath: string;
  fixtureRoot: string;
  createdAt: number;
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function productionStateDir(env: NodeJS.ProcessEnv): string | undefined {
  const localAppData = env.LOCALAPPDATA;
  return localAppData ? resolve(join(localAppData, 'WebAgentGateway')) : undefined;
}

/**
 * A filesystem backend confined to one fixture root.
 *
 * It re-checks containment on every call rather than trusting the path it was handed, because the
 * whole point of the lane is that a mistake here cannot reach anything real.
 */
function fixtureBackend(fixtureRoot: string): FileMutationBackend {
  const target = (root: string, path: string): string => {
    if (resolve(root) !== fixtureRoot) throw new Error('Harness lane backend: workspace root is not this lane fixture');
    const full = resolve(join(root, path));
    if (!within(fixtureRoot, full)) throw new Error('Harness lane backend: path escapes the fixture');
    return full;
  };
  return {
    kind: BACKEND_KIND,
    async readExact(root, path) { return readFile(target(root, path), 'utf8'); },
    async readExactIfPresent(root, path) {
      try { return await readFile(target(root, path), 'utf8'); }
      catch { return undefined; }
    },
    async createNew(root, path, candidate) {
      await writeFile(target(root, path), candidate, { flag: 'wx' });
    },
    async updateExisting(root, path, original, candidate) {
      const full = target(root, path);
      if (await readFile(full, 'utf8') !== original) throw new Error('Harness lane backend: stale target');
      await writeFile(full, candidate);
    },
  };
}

/**
 * Create a fresh, disposable lane.
 *
 * `root` must not exist. That is the rule that makes adoption impossible: there is no code path
 * here that opens an existing store, so no existing store can be brought under this authority.
 */
export async function createHarnessLane(options: {
  lane: typeof HARNESS_LANE;
  root: string;
  env?: NodeJS.ProcessEnv;
  repositoryRoot?: string;
}): Promise<HarnessLane> {
  const env = options.env ?? process.env;
  if (env.WAG_HARNESS_LANE !== '1') {
    throw new Error('Harness lane is disabled; set WAG_HARNESS_LANE=1 to enable it for a test run');
  }
  if (options.lane !== HARNESS_LANE) throw new Error('Harness lane requires the exact test-only lane literal');
  if (!isAbsolute(options.root)) throw new Error('Harness lane root must be absolute');

  const root = resolve(options.root);
  const stateDir = productionStateDir(env);
  if (stateDir && within(stateDir, root)) {
    throw new Error('Harness lane root must be outside the production state directory');
  }
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  if (within(repositoryRoot, root)) {
    throw new Error('Harness lane root must be outside the repository, so it cannot mutate canonical sources');
  }
  const exists = await stat(root).then(() => true, () => false);
  if (exists) throw new Error('Harness lane root already exists; a lane is created fresh and never adopted');

  const fixtureRoot = resolve(join(root, FIXTURE_DIR));
  const storePath = resolve(join(root, STORE_FILE));
  await mkdir(fixtureRoot, { recursive: true });

  const marker: LaneMarker = {
    laneId: `lane_${randomUUID()}`, lane: HARNESS_LANE, storePath, fixtureRoot, createdAt: Date.now(),
  };
  await writeFile(join(root, MARKER_FILE), JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 });

  return build(root, marker, env);
}

function build(root: string, marker: LaneMarker, env: NodeJS.ProcessEnv): HarnessLane {
  const stateDir = productionStateDir(env);
  if (stateDir && within(stateDir, resolve(marker.storePath))) {
    throw new Error('Harness lane refuses a store inside the production state directory');
  }

  const store = new SqliteDurableStore(marker.storePath);
  const backend = fixtureBackend(marker.fixtureRoot);
  const coordinator = new DurableMutationCoordinator({ store, backends: [backend] });
  const caller = createGatewayCallerContext({
    ownerId: `owner_${marker.laneId}`, sessionId: `session_${marker.laneId}`, adapterId: 'harness.lane.test-only',
  });
  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: marker.fixtureRoot, backendKind: BACKEND_KIND, createdAt: Date.now(),
  });

  /**
   * Re-derive what a record belongs to, and refuse anything that is not this lane's.
   *
   * The check is on the workspace's canonical root rather than on an id, because an id is just a
   * string a caller can hand over — this asks where the record would actually write.
   */
  const assertOwnRecord = (mutationId: string): void => {
    const record = store.getMutation(mutationId);
    if (!record) throw new Error('Harness lane: no such record in this lane');
    if (record.workspaceId !== workspace.workspaceId) {
      throw new Error('Harness lane: record belongs to another workspace');
    }
    const ws = store.getWorkspace(record.workspaceId);
    if (!ws || resolve(ws.canonicalRoot) !== marker.fixtureRoot) {
      throw new Error('Harness lane: record does not resolve to this lane fixture');
    }
  };

  const fixturePath = (path: string): string => {
    const full = resolve(join(marker.fixtureRoot, path));
    if (!within(marker.fixtureRoot, full)) throw new Error('Harness lane: path escapes the fixture');
    return full;
  };

  return {
    laneId: marker.laneId,
    fixtureRoot: marker.fixtureRoot,
    async propose(input) {
      const { createHash } = await import('node:crypto');
      const current = await readFile(fixturePath(input.path), 'utf8');
      const preview = await coordinator.preview(caller, workspace.workspaceId, {
        path: input.path,
        baseSha256: createHash('sha256').update(current, 'utf8').digest('hex'),
        before: input.before,
        after: input.after,
      });
      if (preview.status !== 'approval_required' || !preview.mutationId) {
        throw new Error(`Harness lane: proposal was not accepted (${preview.status})`);
      }
      return { mutationId: preview.mutationId, resultSha256: preview.resultSha256 ?? '' };
    },
    async approve(mutationId) {
      assertOwnRecord(mutationId);
      return coordinator.approveLocal(mutationId);
    },
    reject(mutationId) {
      assertOwnRecord(mutationId);
      return coordinator.rejectLocal(mutationId);
    },
    pending() {
      return coordinator.listPendingLocal(50).map((r) => ({ mutationId: r.mutationId, path: r.path }));
    },
    async readFixture(path) { return readFile(fixturePath(path), 'utf8'); },
    async writeFixture(path, content) {
      await mkdir(resolve(join(fixturePath(path), '..')), { recursive: true });
      await writeFile(fixturePath(path), content, 'utf8');
    },
    close() { store.close(); },
    async destroy() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Exported for tests: the separator-aware containment rule the guards use. */
export const harnessLaneInternals = { within, sep };
