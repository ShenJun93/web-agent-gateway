/**
 * The harness test-authority lane.
 *
 * Iterating on WAG end to end used to cost the operator two real gestures per attempt — Run in the
 * side panel, then approve on the review server. That is correct for production and unbearable for
 * debugging, so this provides a lane where the *equivalents* of both can be driven by a script.
 *
 * It is not a mode of the production path: there is no test-mode branch in `operator-server.ts` or
 * in the coordinators, and nothing in production imports this file. It is a second, separate
 * client of the same coordinator classes.
 *
 * ## Why it cannot reach a production record
 *
 * Two facts do the work, and they are named here because an earlier version of this comment
 * advertised guards that turned out to be unreachable while leaving the real reasons unstated.
 *
 * 1. **The store filename is a constant this file owns.** `STORE_FILE` is never derived from
 *    caller input, and it is not the production store's name. There is no argument by which the
 *    lane's store path becomes a real WAG store.
 * 2. **A lane is created, never opened.** The root is made with a non-recursive `mkdir`, which
 *    fails atomically if anything is already there — so an existing directory cannot be adopted,
 *    and there is no check-then-create window to race.
 *
 * Everything below those two is defence in depth, and is described as such: the lane id stamped
 * into the store and re-checked on every operation, the canonicalised containment, the workspace
 * re-derivation. Each would catch a mistake; none of them is the reason production is out of reach.
 *
 * ## What it still is not
 *
 * A file, which can be edited. This is the same same-user exposure ADR-0019 already places outside
 * the containment claim. See `docs/benchmarks/2026-09-20-harness-test-lane-decision.md`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayCallerContext } from './caller-context.js';
import { SqliteDurableStore } from './durable-store.js';
import { DurableMutationCoordinator } from './durable-mutation.js';
import { canonicalWorkspace } from './path-policy.js';
import type { FileMutationBackend } from './file-mutation-backend.js';

/** The literal a caller must pass. A boolean would be easy to set by accident. */
export const HARNESS_LANE = 'harness-test-only' as const;

/** Owned by this file, never derived from input. This is containment fact 1. */
const STORE_FILE = 'harness-lane.sqlite';
const MARKER_FILE = 'harness-lane.json';
const FIXTURE_DIR = 'fixture';
const BACKEND_KIND = 'harness-lane-fs';

export interface HarnessLane {
  readonly laneId: string;
  readonly fixtureRoot: string;
  /**
   * The Run equivalent: submits a proposal to WAG, exactly as pressing Run does. It creates a
   * durable record awaiting review and causes no effect on its own.
   */
  propose(input: { path: string; before: string; after: string; baseSha256?: string }): Promise<{ mutationId: string; resultSha256: string }>;
  /** The operator-approval equivalent: the only thing that causes an effect. */
  approve(mutationId: string): Promise<boolean>;
  reject(mutationId: string): boolean;
  pending(): Array<{ mutationId: string; path: string }>;
  readFixture(path: string): Promise<string>;
  writeFixture(path: string, content: string): Promise<void>;
  close(): void;
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

/**
 * The repository this module was compiled from, not the process working directory.
 *
 * Taking it from a caller — as an earlier version did — let a decoy value place a lane inside the
 * worktree, where `destroy()` would then recursively remove it.
 */
function repositoryRoot(): string {
  return resolve(fileURLToPath(new URL('..', import.meta.url)));
}

/**
 * A filesystem backend confined to one fixture root, canonicalised.
 *
 * `readExactIfPresent` rethrows anything that is not a missing file, because the backend contract
 * requires absence to be distinguishable from every other read failure — a creation that read a
 * permission error as "absent" would become an overwrite. An earlier version swallowed everything,
 * including this backend's own containment refusal.
 */
function fixtureBackend(fixtureRoot: string): FileMutationBackend {
  const target = (root: string, path: string): string => {
    if (resolve(root) !== fixtureRoot) throw new Error('Harness lane backend: workspace root is not this lane fixture');
    const full = resolve(join(root, path));
    if (!within(fixtureRoot, full)) throw new Error('Harness lane backend: path escapes the fixture');
    return full;
  };
  const missing = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
  return {
    kind: BACKEND_KIND,
    async readExact(root, path) { return readFile(target(root, path), 'utf8'); },
    async readExactIfPresent(root, path) {
      const full = target(root, path);
      try { return await readFile(full, 'utf8'); }
      catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
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

export async function createHarnessLane(options: {
  lane: typeof HARNESS_LANE;
  root: string;
  env?: NodeJS.ProcessEnv;
}): Promise<HarnessLane> {
  const env = options.env ?? process.env;
  if (env.WAG_HARNESS_LANE !== '1') {
    throw new Error('Harness lane is disabled; set WAG_HARNESS_LANE=1 to enable it for a test run');
  }
  if (options.lane !== HARNESS_LANE) throw new Error('Harness lane requires the exact test-only lane literal');
  if (!isAbsolute(options.root)) throw new Error('Harness lane root must be absolute');

  // Fail closed, like the CLI does with the same variable. An absent LOCALAPPDATA previously made
  // the production-state check vanish rather than refuse.
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) {
    throw new Error('Harness lane requires LOCALAPPDATA to locate the production state directory it must avoid');
  }
  const stateDir = resolve(join(localAppData, 'WebAgentGateway'));

  const root = resolve(options.root);
  const repository = repositoryRoot();

  /** Judged twice: once on the path as written, and again on what it turns out to be. */
  const assertOutside = (candidate: string): void => {
    if (within(stateDir, candidate)) {
      throw new Error('Harness lane root must be outside the production state directory');
    }
    if (within(repository, candidate)) {
      throw new Error('Harness lane root must be outside the repository, so it cannot mutate canonical sources');
    }
  };

  // Lexically first, so an obviously wrong root is refused before anything is created.
  assertOutside(root);

  // Non-recursive: this both creates the root and asserts nothing was there, in one atomic step.
  // A `stat` followed by a create leaves a window, and the directory could appear inside it.
  try {
    await mkdir(root);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EEXIST') throw new Error('Harness lane root already exists; a lane is created fresh and never adopted');
    throw error;
  }

  try {
    // Then again on the canonical path: a junction, an 8.3 short name or a UNC spelling all name
    // the same directory as a path that would otherwise look "outside".
    const canonicalRoot = await realpath(root);
    assertOutside(canonicalRoot);

    const fixtureRoot = resolve(join(canonicalRoot, FIXTURE_DIR));
    await mkdir(fixtureRoot, { recursive: true });
    // The same admission the production surface uses, so the lane cannot admit a workspace
    // production would refuse — a drive root, a system directory, a sensitive segment, a UNC path.
    const admitted = await canonicalWorkspace(fixtureRoot, [canonicalRoot]);

    const marker: LaneMarker = {
      laneId: `lane_${randomUUID()}`,
      lane: HARNESS_LANE,
      storePath: resolve(join(canonicalRoot, STORE_FILE)),
      fixtureRoot: admitted,
      createdAt: Date.now(),
    };
    await writeFile(join(canonicalRoot, MARKER_FILE), JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 });
    return build(canonicalRoot, marker, stateDir);
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function build(root: string, marker: LaneMarker, stateDir: string): HarnessLane {
  if (within(stateDir, resolve(marker.storePath))) {
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
   * Re-read the marker and confirm it still describes this lane.
   *
   * Defence in depth, and honestly labelled: the containment does not rest on this. It exists so
   * that a lane whose directory has been swapped underneath it stops rather than continues, and so
   * the marker is something the code consults rather than decoration.
   */
  const assertLaneIntact = async (): Promise<void> => {
    const raw = await readFile(join(root, MARKER_FILE), 'utf8');
    const seen = JSON.parse(raw) as LaneMarker;
    if (seen.laneId !== marker.laneId || seen.lane !== HARNESS_LANE
      || resolve(seen.storePath) !== resolve(marker.storePath)
      || resolve(seen.fixtureRoot) !== resolve(marker.fixtureRoot)) {
      throw new Error('Harness lane marker no longer describes this lane');
    }
  };

  /** Defence in depth: a record must belong to this store's one workspace and resolve to it. */
  const assertOwnRecord = (mutationId: string): void => {
    const record = store.getMutation(mutationId);
    if (!record) throw new Error('Harness lane: no such record in this lane');
    if (record.workspaceId !== workspace.workspaceId) {
      throw new Error('Harness lane: record belongs to another workspace');
    }
    const ws = store.getWorkspace(record.workspaceId);
    if (!ws || resolve(ws.canonicalRoot) !== resolve(marker.fixtureRoot)) {
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
      await assertLaneIntact();
      // The caller may supply the base hash, so a proposal can be made to refer to bytes other
      // than the ones on disk right now — which is what production does, and what makes the
      // drift refusal reachable here at all.
      const baseSha256 = input.baseSha256
        ?? createHash('sha256').update(await readFile(fixturePath(input.path), 'utf8'), 'utf8').digest('hex');
      const preview = await coordinator.preview(caller, workspace.workspaceId, {
        path: input.path, baseSha256, before: input.before, after: input.after,
      });
      if (preview.status !== 'approval_required' || !preview.mutationId) {
        throw new Error(`Harness lane: proposal was not accepted (${preview.status})`);
      }
      return { mutationId: preview.mutationId, resultSha256: preview.resultSha256 ?? '' };
    },
    async approve(mutationId) {
      await assertLaneIntact();
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
