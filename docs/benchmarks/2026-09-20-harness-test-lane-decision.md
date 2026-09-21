# Harness test-authority lane — decision and bounds

Date: 2026-09-20, extended 2026-09-21
Status: DECIDED — test-only authority surface, locally authorised
Candidate: `fabd369`, extended by `f79d718` and `2fd3b0f`
Base: `fc0541c`
Authority: operator decision of 2026-09-20 (quoted below)
Related: ADR-0019, ADR-0023, ADR-0026,
`docs/benchmarks/2026-09-20-operator-origin-repair-decision.md`

This exists because the change it records is a **larger carve-out than the one already written
down**, and the existing receipt bounds its own exception by naming exactly what it does not
touch. An independent reviewer said it would block on the omission. It was right.

## What was decided

The operator authorised a test-only lane in which Claude may perform the equivalents of both
production gestures, so that iterating does not cost two human actions per attempt:

> Repeated debugging must NOT require me to perform production Run + operator Approve on every
> iteration. Design and implement the smallest isolated TEST-ONLY autonomous authority lane. […]
> Prefer a genuinely separate harness-specific authority surface rather than
> `if (TEST_MODE) approveEverything()`. […] Production human-presence semantics remain unchanged.

## Why this needed its own record

`2026-09-20-operator-origin-repair-decision.md` accepts the browser probe as a bounded exception
and bounds it precisely:

> the coordinator is a stub defined in the file; approving it increments a counter and touches
> nothing else — **no durable store, no workspace, no backend**

The lane has all three: a real `SqliteDurableStore`, a real workspace row, and a real filesystem
backend that writes files. It approves through `DurableMutationCoordinator.approveLocal` — the
same call the operator's Approve button reaches. ADR-0026 states `RUN_AND_APPROVAL = HUMAN` with
no carve-out for a stub, and the cutover receipt records
`HUMAN_GESTURES_REQUIRED = RUN_IN_PANEL + APPROVE_IN_OPERATOR`.

So this is not a smaller version of the accepted exception. It is a bigger one, and it is recorded
as such rather than folded into the previous receipt.

## What actually contains it

Two facts, and they are named in this order because a review found the file advertising guards
that did nothing while leaving the real reasons unstated:

1. **The store filename is a constant the module owns.** `harness-lane.sqlite`, never derived from
   caller input, and not production's `browser-operator-v4.sqlite`. There is no argument by which
   the lane's store path becomes a real WAG store.
2. **A lane is created, never opened.** The root is made with a non-recursive `mkdir`, which fails
   atomically if anything is already there. An earlier version used `stat` then create, which left
   a window; that is closed.

Everything else is defence in depth and is labelled that way in the source. Each of the following
has a test that fails without it — an earlier draft listed them above a block of passing test names
that did not, in fact, cover five of them:

- the lane id is stamped into a marker and re-read before every operation that writes durable
  state: `propose`, `approve`, `reject` and `pending`. The last is included because listing runs
  the overdue sweep, which transitions records and writes audit rows — it is not the read it looks
  like. The fixture read/write helpers are not checked; they touch no durable state;
- containment is judged lexically and then again on the `realpath`, which catches a junction or an
  8.3 short name. **A UNC spelling is not caught by that re-check** — Windows compares a UNC path
  and a drive-letter path as unrelated roots, so one physically inside the production state
  directory reads as outside it. It is refused separately and earlier, before anything is created;
- the fixture is admitted through `canonicalWorkspace`. Its real contribution here is refusing
  sensitive segments and system directories; the allowed-root argument is satisfied by construction
  and buys nothing;
- an absent or relative `LOCALAPPDATA` fails closed. A *wrong absolute* one still points the guard
  at the wrong directory — this narrows the hole rather than closing it, and the tests themselves
  pass a synthetic value;
- the repository root is derived from the module's own location, not from a caller. Since the root
  is now created with a non-recursive `mkdir`, `destroy()` can only remove a directory the lane
  itself made, so this is belt over braces rather than the thing preventing a loss;
- approval re-derives the record's workspace and refuses anything that does not resolve to this
  lane's fixture. This one was listed here from `fabd369` and was **not** in fact covered until
  2026-09-21: the existing test exercised the id comparison, the first of the guard's two arms,
  and the re-derivation arm would have passed deleted. A fourth review found it. The heading
  above this list is true now; it was not when it was written.

The lane can **create** files in its fixture, not only edit them: `propose` accepts a caller-supplied
`baseSha256`, and an empty base routes approval through the creation path. That is a capability, and
it is named here rather than left to be discovered.

## What it does not bound

```text
THE LANE IS A FILE, AND A FILE CAN BE EDITED
```

Same same-user exposure ADR-0019 already places outside the containment claim. The lane makes a
theoretical hatch into a maintained one, in exchange for iteration that does not spend the
operator's attention on every attempt. That trade is the decision; it is not a proof that the
hatch closed.

Also honest: the opt-in (`WAG_HARNESS_LANE=1` plus the exact lane literal) is read from a
parameter that defaults to the process environment. It is closed against anything outside this
repository; it is one argument away for any test or script inside it. "Test-only" is accurate;
"off by default" would overstate it.

And one consequence of shipping this at all, which belongs here rather than in a review: the
harness guard's tripwire for direct writes to WAG's durable state matches the production store's
filename *plus* a SQL verb. A program that opens that store through `SqliteDurableStore` and calls
`approveLocal` matches neither. That was already the documented same-user shell hatch — the guard
is a tripwire, not a sandbox — but the repository now ships a maintained, copy-pasteable worked
example of the shape, and that is a real change in how easy the hatch is to find.

## Where the decision lives

At the ADR layer, as `docs/adr/0027-allow-a-fixture-only-harness-authority-lane.md`. A review
pointed out that recording it only here left ADR-0026's invariant reading as absolute to anyone
following AGENTS.md's reading order, which puts ADRs before benchmarks. This receipt is the
evidence; the ADR is the decision.

`.claude/rules/human-presence-boundary.md` still states the invariant without a qualifier. That
file is covered by a deny rule the harness itself installed, so it was not edited here. Until it
is, a reader of that rule holds a stronger belief than ADR-0027 supports.

## Production is untouched, verified rather than asserted

A test walks **everything that ships** — `src/`, `scripts/` and `browser/extension/`, including the
v4 service worker — and asserts none of it imports the lane, references it, or contains an
approval-bypass branch under any of nine spellings. The first version checked four spellings across
six hand-picked files, and the extension was outside it entirely.

The lane's own imports are pinned to the coordinator, the store, the caller context, the path
policy and the backend type. A dynamic import in any form — awaited, chained, or via
`createRequire` — fails the test, because a static import list cannot see one. The lane is also
excluded from `tsconfig.build.json`, so a test-only authority surface does not land in `dist/`
beside the production modules.

## Evidence at `fabd369`

```text
test/harness-authority.test.ts   9 pass / 0 fail
  the lane drives both gestures, so an iteration needs no human
  the lane is off unless it is deliberately turned on
  a lane is created fresh and can never adopt an existing store
  the lane refuses to live in the production state directory or in the repository
  a record id from another store is simply not there, which is what isolates the lane
  the workspace guard fires when a record in this store belongs elsewhere
  the lane cannot write outside its own fixture
  production carries no auto-approve bypass and does not know this lane exists
  the lane is disposable and leaves nothing behind
```

The lane keeps the shape of what it stands in for: proposing creates a durable record and changes
nothing on disk, approval is what causes the effect, reviewed bytes equal written bytes, and a
second approval does nothing.

## What `f79d718` and `2fd3b0f` added, 2026-09-21

The lane could propose and approve. It could not iterate the things the mission actually needed
iterated, so it gained three capabilities:

- **an injectable clock** (`now`, `advanceClock`) and a `reviewTtlMs`, both passed to the
  coordinator. Expiry is a function of time; a test that waited real seconds would be slow and
  flaky, and this makes it exact. `durable-store.ts` contains no `Date.now`, so the clock reaches
  every timestamp and no deadline check is left on the wall clock while the lane drives the rest;
- **`reopen()`**, which closes the store and opens it again, rebinding to the same workspace via
  an id now persisted in the marker. This is the restart loop;
- **`serveOperator()`**, which stands the **unmodified production review server** in front of the
  lane's own coordinator. This is what makes the CSRF, Origin, cookie and single-use loops
  reachable at all: the previous browser-backed check used a stub coordinator, which by
  construction never reached the checks it claimed to cover.

ADR-0027 gained a condition 8 for the HTTP property, because the original seven were written for
a lane that was a library.

### What contains the HTTP path

Every coordinator entry the server reaches re-checks the marker — synchronously, because
`listPendingLocal` and `rejectLocal` return values rather than promises — and confines itself to
the lane's one workspace. That was not true when first written: the entries forwarded straight
through, so the only path that causes an effect was the only path with neither guard, while the
module header claimed both ran before every durable write. A review caught it. Unfiltered listing
would also have rendered a record from a second workspace with a working Approve button that
`lane.approve()` refuses — the exact stale-review defect this branch fixed in production.

Two further facts bound it: the lane writes no `.operator-url`, because `operator-server.ts`
touches the filesystem nowhere — the runtime writes that file — so nothing can mistake a lane
server for production's; and both take an ephemeral loopback port, so there is no fixed port to
contend.

### Evidence, and how it was obtained

Ten mutations, each verified to apply before its run, each caught by the test that claims to
cover it: the Origin check, the CSRF comparison, the overdue sweep, the workspace rebinding, the
marker re-read on the HTTP approve path, the HTTP listing's workspace filter, the marker's
`workspaceId` comparison, `assertOwnRecord`'s re-derivation arm, the launcher's loopback bind,
and its parsed-href emission.

This matters because the thing this branch keeps rediscovering is a guard that passes review,
reads convincingly, and is reached by no test. Mutation is the only evidence that distinguishes
the two. One mutation also exposed a test that *hung* rather than failed when its guard was
removed, which is nearly as useless; that is fixed. Another exposed a stray copy of the lane that
the mutation harness itself had left in `src/`, caught by the production-bypass walk.

## Review history

Three independent reviews, in their own sessions, read-only. The third read this lane and reached
the same safety conclusion by a different route — it could not construct a path to a production
record either, but found that the guards the file advertised were unreachable and the two doing
the work were unnamed. Both the code and its description were corrected; that correction is
`fabd369`, and this record states the containment the way the review established it rather than
the way it was first written.

## What this does not authorise

The lane is not a production capability and must not become one without its own ADR. It does not
change production human-presence semantics, adapter identities, protocol versions or capability
profiles. It authorises no push, PR, merge, remote mutation, release, tag, signing, provider
action or machine-wide change.
