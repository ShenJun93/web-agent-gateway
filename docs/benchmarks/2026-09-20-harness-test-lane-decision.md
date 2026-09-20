# Harness test-authority lane — decision and bounds

Date: 2026-09-20
Status: DECIDED — test-only authority surface, locally authorised
Candidate: `fabd369`
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

Everything else is defence in depth and is labelled that way in the source:

- the lane id is stamped into a marker and re-read and compared before every proposal and approval;
- containment is judged twice — lexically, and again on the `realpath`, so a junction, an 8.3 short
  name or a UNC spelling cannot present a path as outside a directory it is inside;
- the fixture is admitted through `canonicalWorkspace`, the same path policy the production surface
  uses, so the lane cannot admit a workspace production would refuse;
- an absent or relative `LOCALAPPDATA` fails closed rather than silently removing the
  production-directory check;
- the repository root is derived from the module's own location, not from a caller — a decoy value
  could otherwise have placed a lane inside the worktree, which `destroy()` removes recursively;
- approval re-derives the record's workspace and refuses anything that does not resolve to this
  lane's fixture.

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

## Production is untouched, verified rather than asserted

A test walks **every** `.ts` file under `src/` — not a hand-picked list, which is what the first
version did — and asserts none of them imports the lane, references it, or contains a
`TEST_MODE` / `autoApprove` / `skipApproval` branch. The lane's own imports are pinned to the
coordinator, the store, the caller context, the path policy and the backend type, and a dynamic
import anywhere in the file fails the test, because a static import list cannot see one.

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
