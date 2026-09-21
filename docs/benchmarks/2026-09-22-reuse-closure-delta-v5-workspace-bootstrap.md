# WHOLE_WAG_REUSE_CLOSURE — delta for the v5 workspace bootstrap

2026-09-22. Scope: **only** the workspace-authority blocker the live `DELEGATED_RUN` proved.
Nothing else was re-audited; the closures of 2026-09-21 and the activation/diagnostics delta of
2026-09-22 stand.

```text
NATIVE -> STANDARD -> PROVEN OSS/SERVICE -> COMPOSE -> WRAP -> EXTEND -> BUILD
```

**Verdict: `WHOLE_WAG_REUSE_CLOSURE = PASS` for this delta.** One production module is new, and it
exists to *remove* duplication rather than add a feature. Everything else is COMPOSE over surfaces
WAG already had — including, importantly, the workspace bootstrap itself, which turned out to need
no new mechanism at all.

---

## A. The bootstrap — COMPOSE, and the mechanism already existed

The blocker read like a missing capability: no v5-owned workspace existed and nothing could create
one. The audit found that the capability was already shipped and merely unused.

| Rung | Considered | Outcome |
| --- | --- | --- |
| **COMPOSE** | `AdmittedWorkspaceService.open(caller, path)` | **Used, unchanged.** It already canonicalises the path against `allowedRoots`, opens it on DevSpace, and stamps the *calling* tuple onto the row. Passing the v5 caller is the entire fix. |
| **COMPOSE** | `bootstrapPrivateGateway` + `DevspaceRepositoryInspectionBackend` | **Used, unchanged.** The activation instrument assembles them exactly as `browser-operator-runtime.ts` does — same constructor arguments, same order. |
| **COMPOSE** | `canonicalWorkspace(path, allowedRoots)` | **Used, and it replaced a duplicate.** The previous instrument lower-cased and slash-normalised roots itself; that was a second, subtly different answer to a question the gateway already answers, and the one the tools would actually apply. Deleted. |
| **EXTEND** | A new workspace-open verb, admin route or protocol version | **Rejected and unnecessary.** v5 already carries `run.stage` + `run.human` for `workspace.open`, and `delegated-run-production-runtime.test.ts` has driven that path end to end since it was written. Nothing needed adding to the protocol. |
| **BUILD** | A second workspace subsystem, row cloning, ownership transfer | **Rejected outright.** Each would have put a second notion of workspace ownership beside the accepted one, which is the invariant the mandate protects. |

**No production code was written for the bootstrap.** The change is that the human activation
instrument now calls the existing service with the v5 caller instead of accepting a workspace id
whose owner it never checked.

---

## B. The ownership check — COMPOSE, after an audit stopped a fifth copy

The check needed at staging and at dispatch is "do these two authority tuples match". Writing it
inline would have been four lines each.

**The audit found the tree already carried four hand-written copies of exactly that predicate:**

```text
src/admitted-workspace.ts      sameAuthority(record, caller)
src/browser-verify-request.ts  sameAuthority(expected, actual)
src/durable-verify-job.ts      sameAuthority(expected, actual)
src/durable-store.ts           sameAuthorityTuple(expected, actual)
```

Identical bodies; four names between them. This is the same finding that produced
`delegationLivenessDenial` — a liveness predicate written four times is how a revocation ends up
honoured in three places and missed in the fourth.

So the two new call sites **compose** one definition rather than adding a fifth and a sixth:

| Rung | What supplies it |
| --- | --- |
| **COMPOSE** | `GatewayAuthority` in `caller-context.ts` — the type for these three fields already existed and is now reused instead of a new `WorkspaceAuthorityRecord` interface. Imported type-only, so it costs nothing at runtime. |
| **BUILD** | `src/authority-tuple.ts` — one exported predicate, three string comparisons, **zero runtime imports**. |

### Why the new module, and why it is not a duplicate itself

It is a *consolidation point*, not a fifth implementation. It is BUILD-new only because there was
nowhere correct to put it: `admitted-workspace.ts` pulls in the DevSpace executor and the store, and
the policy it must serve — `goal-ui-delegation.ts` — is deliberately pure, synchronous and
I/O-free. A three-line predicate should not be the thing that gives the policy a dependency on the
executor. Hence a module with no runtime imports at all.

### The residual, stated rather than quietly left

**The four existing copies were not migrated.** They sit on the verify, mutation and workspace
paths, outside the blocker this milestone was permitted to touch, and each needs its own evidence.
The module's own header names all four and says where they should converge. Converging them is
cheap, separable, and now has a destination — but it did not happen here, and the tree currently
holds one shared predicate and four copies rather than one predicate.

---

## C. Smaller pieces

| Piece | Rung | Note |
| --- | --- | --- |
| `WORKSPACE_NOT_OWNED` | **EXTEND** | One member added to the existing `DelegationDenialCode` union. Distinct from `WORKSPACE_MISMATCH` because they are different facts: the binding named the wrong workspace, versus the bound workspace belongs to someone else. The audit can tell them apart. |
| `getWorkspace` on the dispatch port | **EXTEND** | One name added to `DELEGATION_DISPATCH_PORT_METHODS`. A read. `openWorkspaceRecord` is still absent, so the plane can refuse a workspace and still cannot create, re-own or delete one — pinned by the port-surface test, which calls the forbidden names rather than grepping for them. |
| `--root` / `--workspace` flags | **EXTEND** | Argument parsing in the instrument. Exactly one of the two, because "neither" and "both" are each ambiguous about which workspace a grant would bind. |
| `test/support/workspace-fixture.ts` | **BUILD** (test-only) | ~20 lines. `openWorkspaceRecord` mints its own `ws_<uuid>`, which is right for production and unusable for suites naming `ws_1` in a hundred assertions. It writes the row under the id the fixture already uses, through the same raw handle these suites already take to model a row edited behind WAG's back. Nothing in `src/` can reach it. |

---

## What was deliberately not touched

Per the mandate: `sameAuthority` itself is unchanged and no workspace record is ever re-owned,
cloned or transferred. No new admin API, no new protocol version, no new browser-reachable verb.
The renderer, DevSpace architecture, generic policy and sandboxing were not reopened. The v1–v4
paths are unchanged — the ownership check applies only on the delegated branch, and a test pins
that an undelegated stage is unaffected by workspace ownership, because adding it there would
refuse a person their own Run.
