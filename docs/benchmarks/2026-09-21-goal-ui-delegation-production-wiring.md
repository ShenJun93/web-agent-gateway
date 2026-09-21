# Delegated Run, wired into production

2026-09-21. Branch `feat/goal-ui-delegation-v1`.

The design gate for ADR-0029 passed on evidence three weeks of review could produce without the
thing existing. This records what happened when it was built: two defects the design had, both of
which survived three adversarial reviews, and both of which were found by wiring it up rather than
by reading it again.

## What was missing, and is not any more

The previous receipt listed six unbuilt pieces, measured rather than estimated. All six are built,
plus three that were not on the list and turned out to be required.

| Piece | What it does |
| --- | --- |
| `src/browser-operator-runtime.ts` | constructs the plane, router and coordinator per admitted connection — and only when `goalUiDelegationId` is configured |
| `src/delegation-dispatch-http.ts` | a parallel loopback server with its own v5 registry |
| `src/browser-adapter/native-host-v5.ts` + `local-link-v5.ts` + `native-host-delegation-main.ts` | a second native host binary |
| `browser/extension/native-session-core-v5.js` + `service-worker.js` | the shipped worker tries the delegated path, and falls through to the human queue on any refusal |
| `src/delegation-claim-sweeper.ts` | retires `CLAIMED` rows a crash stranded |
| `protocol-v5` `run.human` | v5 is no longer delegated-only |
| **`src/delegated-run-executor.ts`** | *not on the list* — something has to actually run the staged candidate |
| **`src/delegated-tool-execution.ts`** | *not on the list* — and it has to run it through the surface a clicked Run reaches |
| **`scripts/delegation-control.ts`** | *not on the list* — issuance had no path at all, in production, for leases either |

That last row deserves its own sentence. `insertGoalLease` has no production caller and never has:
only `src/harness-authority.ts` and tests. "Issued by a human, out of band" was realised as *there
is no path*, which is airtight and unusable. The delegation control CLI is the first time either
authority has had one.

## The two defects

Both were in the design. Both survived three adversarial reviews. Both were found by building it.

### 1 — the session id was never the value the browser sends

The extension mints a **correlation** and sends it as `sessionId`. WAG hashes the correlation,
resolves a durable `adapter_sessions` row, and that row's id is a *different* `session_<uuid>`
minted by `getOrCreateAdapterSession`. Same shape — both match `OPERATOR_CORRELATION_PATTERN` — and
never the same value.

The router compared them:

```ts
if (envelope.sessionId !== this.options.connection.sessionId) return SESSION_MISMATCH;
```

In production that refuses `session.bind` itself. Not intermittently, not under load — every time,
from the first frame. Delegated Run would never have worked once.

**Why no test caught it.** Every suite used one value for both sides:

```ts
const CONNECTION = { sessionId: SESSION, ... };
r.handle({ ..., sessionId: SESSION, ... });
```

so the comparison held trivially and the mutation "the envelope session is believed instead of
compared" was caught by a test that could not distinguish the two concepts. A fully green suite,
128 delegation tests, three reviews, and a surface that could not bind.

**Closed.** `session.bind` is now the one verb whose `sessionId` is not compared — identity there
comes from the bearer the gateway admitted, and by the time the router runs, admission has already
happened, so `connection` is fixed and the envelope contributes nothing. The bind answer carries the
authoritative id; every later verb is compared against it; and the native host records it from WAG's
answer rather than assuming the correlation is it, failing closed if the answer carries none.

The new suite asserts the two are different strings **in the fixture itself**, so a regression that
conflates them fails rather than passing vacuously:

```ts
assert.notEqual(sessionId, correlationId,
  'the durable session id must differ from the correlation, or this suite proves nothing');
```

### 2 — a delegation's workspace binding constrained nothing for some tools

A delegation binds one `workspaceId`. That binding only means anything because every WAG tool
resolves its workspace from `arguments.workspace_id`, and `validateStageableArguments` requires the
two to agree. Review 3 found and closed that.

What review 3 recorded as an observation — "`health` takes no `workspace_id`, so nothing
cross-checks the staged `workspaceId`" — is the same hole, and the conclusion drawn from it was too
weak. `health` is harmless. **`workspace.open` is not.** It takes a `path`.

So a delegation naming `workspace.open` in `allowedTools` let the browser open *any* path the
config's `allowedRoots` permitted, while the audit row recorded it as acting in the bound workspace.
The delegation read narrow and behaved wide. `allowedRoots` still bounded it — the containment did
not fail — but the delegation's own binding contributed nothing.

**Closed.** `requireWorkspaceBinding` is set exactly when a delegation is named:

```text
delegated path   a tool that resolves no workspace from its arguments cannot be staged
human path       unchanged — there are no bindings there to satisfy, and a person opening a
                 workspace is the gesture the whole design defers to
```

This is a real narrowing: `health` and `workspace.open` can no longer be delegated at all.

## The live proof

`test/delegated-run-production-runtime.test.ts`. Nothing below `startBrowserOperatorRuntime` is
stubbed — real config loader, real store, real v5 admission server, real native host over streams
with real length-prefixed framing, and the same `createBrowserOperatorAdmittedMcpServer` a clicked
Run reaches.

It walks the documented bootstrap rather than shortcutting it:

```text
1. name a placeholder id, start WAG        surface up, authorises nothing
2. connect the extension                   WAG mints the v5 session
3. open a workspace on the HUMAN path      run.stage + run.human -> HUMAN_RUN
4. issue a delegation out of band          bound to that session and workspace
5. name it, restart WAG
6. reconnect with the same correlation     the SAME session comes back
7. stage + dispatch repo.search            DELEGATED_RUN, zero clicks
```

Step 6 is the one a design document cannot establish. If the session did not survive a restart, a
delegation would stop matching the moment it was configured, and the whole scheme would be unusable
in a way no unit test would show. It survives, because a session is keyed by the correlation the
extension holds in `chrome.storage.session`.

The result:

```text
authority   DELEGATED_RUN
goalId      goal_production_runtime
resultId    res_<32 hex>
result      repo.search found the needle in a real git-tracked file
row state   RESULTED, under the durable session id, in the bound workspace
claims      1 of 2
```

and in the same store, from step 3:

```text
authority   HUMAN_RUN
delegation  (none)
```

Two authorities, one table, distinguishable after the fact — which is what the audit requirement
asked for.

Also pinned there: with no `goalUiDelegationId`, the entire v5 surface is absent (no server, no
discovery file, no sweeper) and v4 is untouched; a configured placeholder naming no row is refused,
because naming is not granting; and revocation from a second connection lands on the very next call
with no restart.

## What a crash costs

`CLAIM` spends the slot, before anything runs. **Nothing refunds it, ever** — a refund would make a
crash a way to exceed `maxActions`.

| Crash point | Row ends at | Slot | Re-runnable |
| --- | --- | --- | --- |
| between CLAIM and DISPATCH | `ABANDONED`, by the sweeper | spent | no — and no Run was recorded |
| between DISPATCH and result | `DISPATCHED`, no result | spent | no — `DISPATCHED` can never return to `STAGED` |
| tool throws or errors | `DISPATCHED`, no result | spent | no |

The sweeper never touches a `DISPATCHED` row. That row reached a tool; abandoning it would claim
knowledge nobody has. `test/delegated-run-recovery.test.ts` covers all three, plus restart after
`CLAIMED` and after `DISPATCHED`, and that a restart does not reset the budget.

## Mutation testing

The battery said "0 survived" about code that did not exist. Twenty mutations were added across the
executor, the sweeper, the transport seam, the workspace binding, the native host and the loopback
server.

**Seven survived. One existing mutation no longer applied at all** — its anchor had moved when the
workspace-binding branch changed, so it was scoring as *caught* while mutating nothing, which is
worse than a survivor because it is invisible.

Each survivor was closed with a test, not by retargeting:

| Survivor | What was missing |
| --- | --- |
| a dispatch route accepts any bearer the registry knows | nothing exercised the coordinator-map check separately from the registry |
| the dispatch server answers requests carrying a browser Origin | no test sent an `Origin` header |
| the host answers a transport failure as a policy refusal | no test killed the server mid-session |
| the sweeper abandons dispatched rows too | the existing test used a `RESULTED` row, which the mutation does not touch |
| the executor runs a row that never reached DISPATCHED | unreachable through the router |
| the executor does not re-validate the stored arguments | unreachable through the router |
| the executor runs whatever the router answered | *caught after the first fix; listed for completeness* |

The last two are the recurring defect class in its purest form: guards written confidently and
reached by no test. They are now reached by handing the **executor** a port that returns a row the
store never would, while the router keeps the real one — so the decision and the durable transition
stay genuine and only the post-transition read is tampered with. That models a same-user edit to the
SQLite file, which ADR-0019 places outside the containment claim but which these guards cost nothing
to keep.

One mutation was retargeted rather than tested, and it is named here because retargeting is how a
battery gets quietly weakened: the router's own `SESSION_MISMATCH` is unreachable through the
production path, because the native host records the authoritative id from the bind answer and
refuses anything else a layer earlier. Both layers have their own mutation; only the suite each
runs against changed.

```text
102 mutations, 96 caught, 6 redundant-by-design, 0 survived, 0 inconclusive, exit 0
```

## Residual limits

- **Issuance is a rule, not a mechanism.** `scripts/delegation-control.ts` is a script, and code
  cannot tell whose hands are on the keyboard. What is enforced is narrower and still worth having:
  nothing on the browser path can reach the control plane or the store methods behind it, because
  the dispatch plane is handed a port object that lacks them at runtime. Adding `listAdapterSessions`
  and `listWorkspacesForOwner` to the store widened nothing there — the port is built by enumerating
  the names it may carry, so a new store method is absent from it until someone lists it.
- **The human gate still lives in the browser.** The gateway cannot distinguish a clicked Run from
  an unclicked one, on v4 or v5. `run.human` is how the panel reports a click; it is not what makes
  a Run human. Unchanged by this revision, and `HUMAN_RUN` still means exactly "no delegation
  authorised this".
- **One process, one store, two surfaces.** The v4 and v5 admission registries are disjoint and
  workspaces are scoped to `(ownerId, sessionId, adapterId)`, so a v5 session cannot use a v4
  session's workspace — which is why the live proof has to open its own.
- **An extension reload breaks a delegation.** It re-mints the correlation, so the session changes
  and the binding stops matching. That is the binding working; it also means a delegation is worth
  minutes, not hours, in practice.
- **`npm run lease:stop` halts delegated Run as well**, because ADR-0029 reuses the same
  kill-switch file rather than adding a second one nobody would remember in an emergency. Verified:
  the runtime reads `dirname(statePath)` and `stateDirectory()` returns the same
  `LOCALAPPDATA\WebAgentGateway`. `scripts/lease-stop.ts` now says so — it was understating what it
  does, which is the safe direction but still inaccurate.
