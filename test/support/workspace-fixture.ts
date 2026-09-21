/**
 * Give a durable store a workspace row with a chosen id, owned by a chosen caller tuple.
 *
 * ## Why this exists
 *
 * A delegated Run now requires the delegated workspace to be a row **this browser context owns**,
 * because a delegation bound to someone else's workspace spends a budget slot on work every tool
 * will refuse. Closing that meant every delegated fixture needs a real workspace row.
 *
 * `openWorkspaceRecord` mints its own `ws_<uuid>`, which is correct for production and unusable for
 * suites that name `ws_1` in a hundred assertions. So this inserts the same row shape under the id
 * the fixture already uses, through the store's own handle — the same reach these suites already
 * take when they model a staged row edited behind WAG's back.
 *
 * ## What it is not
 *
 * It is a fixture, never a capability. Nothing under `src/` imports it, the dispatch port carries
 * only `getWorkspace` and cannot create one, and production still has exactly one route to a
 * workspace: `AdmittedWorkspaceService.open`, which canonicalises the path against the configured
 * allowed roots and stamps the calling tuple onto the row.
 */
import type { SqliteDurableStore } from '../../src/durable-store.js';

interface RawHandle {
  db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
}

export function giveWorkspace(store: SqliteDurableStore, input: {
  workspaceId: string;
  ownerId: string;
  sessionId: string;
  adapterId: string;
  canonicalRoot?: string;
  backendKind?: string;
  createdAt?: number;
}): string {
  (store as unknown as RawHandle).db.prepare(`INSERT OR REPLACE INTO workspaces
    (workspace_id, owner_id, session_id, adapter_id, canonical_root, backend_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.workspaceId,
      input.ownerId,
      input.sessionId,
      input.adapterId,
      input.canonicalRoot ?? `/fixture/${input.workspaceId}`,
      input.backendKind ?? 'devspace',
      input.createdAt ?? 1_000_000,
    );
  return input.workspaceId;
}
