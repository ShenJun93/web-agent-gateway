# The v5 workspace bootstrap, and the slot it stops wasting

2026-09-22. Branch `feat/goal-ui-delegation-v1`. Scope: **only** the blocker the live
`DELEGATED_RUN` proved. `DELEGATED_RUN` and durable replay protection are not reopened; they were
demonstrated in production on the same day and stand.

## The defect, restated from the measurement

A human-submitted prompt produced a real delegated Run: the extension observed one candidate, WAG
admitted it, a budget slot was spent, the audit row was written — and `result_id` was null.

```text
workspaces.ws_4e2d106c…   session_13150a33-…   browser.chatgpt.native.operator.v4
the delegated caller      session_6cc39863-…   browser.chatgpt.native.delegation.v5
```

`AdmittedWorkspaceService` requires the owner, session **and** adapter to match, so the v5 caller
was denied the workspace its own delegation named. Across the whole store: 13 workspaces on v4,
zero on v5.

**The refusal at execution was correct and is unchanged here.** The defect was upstream of it: a
delegation could be issued naming a workspace its bound session did not own, and nothing refused
that — not the activation instrument, which checked the workspace existed and its root was allowed
but never who owned it, and not the dispatch plane, which compared the workspace *id* against the
binding and never the row's owner. So WAG spent one of eight slots on work that could not complete,
and single-assignment state means that slot never comes back.

## What was actually missing, which was less than it looked

The blocker read as a missing capability — no v5-owned workspace existed and nothing could create
one. It was not.

**v5 already carries the mechanism.** `run.stage` + `run.human` for `workspace.open` has existed
since the protocol was written, and `delegated-run-production-runtime.test.ts` has driven it end to
end the whole time: it opens a workspace on the human path, gets back a `ws_…` the v5 session owns,
and then binds a delegation to it. That test passed unmodified through this change, which is the
clearest evidence that no new mechanism was needed.

What was missing was a *caller*. The shipped side panel still drives v4, so a human Run opens a
v4-owned workspace; and the activation instrument accepted a workspace id from the operator without
ever asking who owned it. Neither of those is a protocol gap.

## The fix, in three places

### 1. The activation instrument mints the workspace it binds

`docs/pending/activate-delegation-control.mjs` now takes **`--root <path>`** and opens a new
workspace through `AdmittedWorkspaceService.open`, passing the caller tuple read from the durable
v5 session row. Same `canonicalWorkspace` check against the same `allowedRoots`, same DevSpace
open, same row shape — the service stamps the calling tuple onto the row, so the workspace comes
out owned by the session the delegation is about to bind.

`--workspace <id>` remains, for reusing a workspace that same v5 session already owns, and is
refused outright when any part of the tuple differs. Exactly one of the two flags; neither and both
are each ambiguous about which workspace a grant would bind.

**The root is named by the human on the command line.** No page, provider or proposal can choose or
widen it: a proposal may only name a workspace id, that id must equal the one the delegation binds,
and that binding must be owned. Three exact comparisons, none of them influenced by page text.

The ordering property is preserved. Both grants are still minted before either is named, and still
named in one atomic replace. Minting a workspace is a write, so it is numbered as its own step
rather than hidden in the preconditions — but a workspace row is not authority: only the tuple that
owns it can name it, and naming it does nothing until a configured delegation binds it. A failure
between the mint and the config write leaves a workspace and no grant.

### 2. Staging refuses a workspace this context does not own

Before any row is written, and therefore before the queue, the budget or the CLAIM. A candidate
whose delegated workspace belongs elsewhere can never produce an effect, so staging it queues a row
destined to spend a slot and fail — which is precisely what happened. One indexed read; nothing
left behind.

### 3. Dispatch re-reads the fact and refuses before the CLAIM

Not carried from staging. The two moments are separated by however long the candidate sat in the
queue, and the row can change in between — a test re-owns the workspace between the two and pins
that the refusal still lands with `slotClaimed: false`, no run-authority row and no budget spent.

The workspace is looked up by the *delegation's* binding rather than by anything the proposal or
the request said, so a proposal naming another workspace cannot steer the lookup toward a row it
does own; the policy compares the two ids itself, immediately after.

### The new refusal code

`WORKSPACE_NOT_OWNED`, distinct from `WORKSPACE_MISMATCH`. They are different facts — "the proposal
named a workspace the delegation did not bind" versus "the bound workspace belongs to someone
else" — and an operator reading the audit can tell them apart.

## What was not done, deliberately

- **`sameAuthority` is unchanged.** No workspace record is re-owned, cloned, aliased or
  transferred, and no v5 session inherits a v4 session's workspace. That refusal is the invariant;
  the fix is upstream of it.
- **No new admin API, protocol version or browser-reachable verb.** The dispatch port gained one
  *read* (`getWorkspace`). `openWorkspaceRecord` is still absent from it, so the plane can refuse a
  workspace and still cannot create, re-own or delete one — pinned by the port-surface test, which
  calls the forbidden names rather than grepping for them.
- **The v1–v4 paths are untouched.** The ownership check applies only on the delegated branch. A
  test pins that an undelegated stage is unaffected by workspace ownership, because adding it there
  would refuse a person their own Run — ADR-0026 holds unchanged wherever no delegation authorises
  the proposal.
- **Issuance-time refusal in `UiDelegationControlPlane` was considered and not added.** It would be
  the strongest place, but it couples issuance to workspace state and would require a real workspace
  row behind roughly twenty existing delegated fixtures. The mandate placed this check in the
  activation instrument, which is the only issuance path there is, and the dispatch plane now
  refuses independently of it. Recorded as an option, not as done.

## A reuse audit stopped a fifth copy

The check is "do these two authority tuples match". The tree already carried **four hand-written
copies** of that predicate — `admitted-workspace.ts`, `browser-verify-request.ts`,
`durable-verify-job.ts`, `durable-store.ts` — identical bodies under two names. Writing it inline
twice more would have made six.

`src/authority-tuple.ts` is now the one definition: three string comparisons, zero runtime imports,
reusing the `GatewayAuthority` type that already existed rather than inventing another name for the
same three fields. The two new call sites compose it.

**The four existing copies were not migrated** — they sit on paths outside this blocker and each
needs its own evidence. The module names all four in its header. That is a residual, not a
completed consolidation: the tree currently holds one shared predicate and four copies.

## Evidence

### Focused tests

`test/delegated-workspace-authority.test.ts`, 11 tests, all new:

```text
a v4-owned workspace and a v5 session: refused, and nothing is staged
a v5-owned workspace with the matching session and adapter is admitted
cross-session, cross-adapter and cross-owner are each refused on their own
a workspace id that resolves to no row denies, rather than reading as unconstrained
ownership lost between staging and dispatch costs no claim and no budget
at dispatch, every part of the tuple is compared — not just the adapter
a delegation whose bindings are not an object denies rather than throwing
a delegation whose workspace never existed is refused at dispatch too
ownership survives a restart, so the delegated path still works after one
an undelegated stage is unaffected by workspace ownership
the refusal is recorded as its own reason code, distinct from a binding mismatch
```

`test/activation-step.test.ts` gained five, and now runs 27:

```text
ACTIVATION FAIL: a v4-owned workspace and a v5 session is refused, and mints nothing
ACTIVATION FAIL: a workspace owned by another session, or another principal, is refused
ACTIVATION PASS: a workspace this v5 session owns activates, and the grant names it
--root fails closed without the DevSpace token, rather than minting a workspace some other way
--root outside the configured allowedRoots is refused before anything is reached
it refuses neither or both of --root and --workspace, because either is ambiguous
```

### Mutation testing, which changed the work twice

Nine mutations, each weakening one clause. **The first run had four survivors**, and they were real:

```text
SURVIVED  policy: ownerId no longer compared
SURVIVED  policy: sessionId no longer compared
SURVIVED  policy: the whole ownership check removed
SURVIVED  plane: dispatch looks the workspace up as always-present
```

The first three had one cause: staging refuses the cross-owner and cross-session cases first, so
nothing ever reached the *policy's* copy of the check with only the owner or only the session
wrong. A guard reached by no test is the exact defect this milestone exists to fix, so reintroducing
one a layer down would have been absurd. `at dispatch, every part of the tuple is compared` re-owns
the row after staging, which is the one ordering staging cannot cover, and kills all three.

The fourth was an **equivalent mutation**, not a coverage gap: bindings malformed enough to make the
workspace-id read fall back are denied as `DELEGATION_MALFORMED` before the policy reaches its
workspace check, so the fallback *value* is unobservable. What is observable is that the read does
not throw on bindings of `null`. The mutation was replaced with one that removes the optional chain,
and a test pins the no-throw property. The source says which part is unobservable and why.

Second run: **all 9 killed.**

### An existing guard refused the new import, correctly

The first full-suite run failed one test: `the dispatch plane imports only what a browser-facing
decision needs`, which pins the dispatch plane's import list exactly, because "a new import here is
how issuance would arrive on the browser path by accident". Adding `authority-tuple.js` tripped it —
which is the guard working, not a false positive.

The list was updated deliberately, and the reason it is safe was made **checkable rather than
asserted**: the test now also reads `src/authority-tuple.ts` and requires it to have no runtime
imports at all. Allowing a module with no imports onto the browser path cannot become a route to
anything, and if that module ever grows a runtime import the test fails and the decision is made
again.

### Gates

```text
npm test                     859 tests, 853 pass, 0 fail, 6 todo   exit 0   940.9s
npm run typecheck                                                  exit 0
npm run build                                                      exit 0
npm run test:business        1/1                                   exit 0
npm run test:dc-replacement  1/1                                   exit 0
git diff --check                                                   exit 0
gitleaks detect --no-git     7 findings, none in a changed file
mutation suite               9 of 9 killed
```

The 6 `todo` are the two long-standing `OPEN:` harness-guard residuals and their siblings, marked
todo before this milestone and unrelated to it. The 7 gitleaks findings are the same pre-existing
public values recorded in the 2026-09-20 cutover receipt — the extension's public manifest key, a
`chrome.storage.session` slot name, and Authenticode digests in release docs. None is in a file this
change touched.

The full suite was run twice. The first run is not the evidence: it failed the import guard
described above, and a suite whose result changed after an edit is not a gate. The numbers here are
the second, clean run, with no source edited after it started.

## Residuals

- **The four remaining `sameAuthority` copies.** Named above and in the module header.
- **The shipped side panel still drives v4.** A human Run on the panel still opens a v4-owned
  workspace. That no longer blocks anything — the activation instrument mints the v5 workspace —
  but the panel is still a revision behind, and it was already a recorded residual.
- **The extension diagnostics recorder captured nothing again.** Across service-worker restarts the
  CDP recorder produced no `DIAG` records, in the one run it was added for. The durable evidence
  classified the failure without it, so this is a **post-cutover observability residual** and was
  deliberately not reopened here. It is worth stating plainly that the observability added on
  2026-09-22 has not yet earned its keep in production.
