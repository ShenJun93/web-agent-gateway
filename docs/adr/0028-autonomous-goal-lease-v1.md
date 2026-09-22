# ADR-0028: Autonomous Goal Lease v1

Date: 2026-09-21
Status: Accepted
Depends on: ADR-0019, ADR-0023, ADR-0026, ADR-0027
Evidence: `docs/benchmarks/2026-09-21-autonomous-goal-lease-v1-acceptance.md`
Amends: ADR-0026 and ADR-0027 — see *Consequence for the invariant* below
Amended by: ADR-0029 — a lease lifts Approve and **never Run**, and a lease that admits work
  from a delegated adapter must now name that delegation's goal. See ADR-0029,
  *Consequence for the invariant* and *Composing a delegation with a lease*.

## Context

ADR-0026 requires a human gesture for every effect on a production record, and ADR-0027 carved
out a fixture-only lane so that *iterating* did not cost two gestures per attempt. Neither lets a
goal run to completion without a person: the lane is confined to a fixture it created itself, and
production still needs Run and Approve for each action.

The operator's measured problem is continuous execution. A goal that touches twenty files under
clear, stable constraints currently costs forty human gestures, and the human is not adding
judgement at gesture nineteen — they are adding latency. What the human *is* adding is a bound:
the knowledge that this change, in this repository, on this branch, within this size, is
acceptable.

That bound can be stated once instead of enacted forty times. Stating it once is the decision.

## Decision

A **Goal Lease** is a durable, bounded grant. While an unexpired, unrevoked lease is configured,
WAG's own deterministic policy may admit an action that is strictly inside it, recording the
admission as `POLICY_APPROVED`. Everything else fails closed and still requires a human.

The approver is `evaluateGoalLease` in `src/goal-lease.ts` — a pure, synchronous, I/O-free
function over a durable lease record and a durable proposal record. **The model is never the
approver, and neither is the page.** No browser text reaches the decision: every fact judged is
re-read from the durable store or the filesystem by the coordinator immediately before the
consequence.

### Bindings

A lease grants nothing it does not name:

```text
workspaceRoots     exact canonical roots; the workspace must resolve to one
allowedTools       exact tool names
pathPatterns       relative, forward-slashed, matched without a regex
maxFiles           distinct paths, counted across the lease from durable rows
maxBytes           total written, counted the same way
maxDiffBytes       per-proposal ceiling, independent of remaining budget
admittedSessions   exact session ids
admittedAdapters   exact adapter ids
commitSemantics    'none' by default; 'commit-to-bound-branch' requires branch + headSha
notBefore/expiresAt/revokedAt/leaseId
```

An empty list grants **nothing**, not everything. That inversion is the classic way such an
engine fails open, so it is refused at validation and would deny at evaluation regardless, and a
test asserts both.

### Architecture

```text
browser / Claude proposal
  -> existing validation (path policy, identity, rate limit, size)   unchanged
  -> deterministic Goal Lease policy                                 new
  -> POLICY_APPROVED, only if every binding passes                   new durable row
  -> existing execution machinery (CAS on base hash, then write)     unchanged
  -> durable audit                                                   extended
```

It is emphatically **not** implemented as auto-clicking Run, auto-clicking Approve,
`if (TEST_MODE) approveEverything()`, or model self-approval. `admitByPolicy` shares no code with
the operator server, and the operator server does not know leases exist.

### Distinguishing the two authorities

`mutation_authority` is a new table — new table rather than new columns, because this schema is
created with `CREATE TABLE IF NOT EXISTS` and has no migration framework (ADR-0022, ADR-0023).
One row is written at admission and never updated, recording the authority, the lease id, the
proposal fingerprint, the path, the result hash and the byte count.

Both paths write it, and they write it *inside the store*, so neither call site can forget. That
matters: if only the policy path recorded, "no row" would mean both "a human approved this" and
"never admitted", and the audit could not tell them apart by absence.

## What a lease may never authorize

```text
push · PR · merge · force/reset/history rewrite · release/tag/publication · signing
provider or account actions · payments · identity verification · machine-wide configuration
credential or secret reads · filesystem access outside admitted roots · arbitrary network
access to unrelated browser profiles or sessions
```

Additionally, and checked above the path patterns rather than left to them, a lease cannot grant
edits to its own authority. This has two halves, and the first alone was not enough:

- **by name**: `.claude/`, `.git/`, `docs/adr/`, `AGENTS.md`, `CLAUDE.md`, `package.json` and
  `tsconfig.build.json` are refused even under a `**` pattern (`AUTHORITY_FILE_PROTECTED`);
- **by location**: a workspace resolving inside the checkout the running gateway was loaded from
  is refused outright (`SELF_MODIFICATION_REFUSED`).

The second exists because a review showed the first protected the *configuration* of authority
while leaving every file that *implements* it — `goal-lease.ts` itself, the kill switch, the path
policy, the extension manifest — grantable under an ordinary `src/**` pattern. Adding more names
would have been an arms race against a list; refusing by location is exact, and costs a lease
nothing when it targets an unrelated repository, where `src/foo.ts` is just a file.

A lease is also bounded in time by a ceiling of twelve hours, not only by its own `expiresAt`.

## Consequence for the invariant

ADR-0027 restated the human-presence invariant as:

```text
LOCAL_OPERATOR_APPROVAL = REQUIRED_FOR_EVERY_EFFECT_ON_A_PRODUCTION_RECORD
RUN_AND_APPROVAL = HUMAN_ON_THE_PRODUCTION_PATH
```

This decision authorises policy admission **on a production record, on the production path**, so
both of those are now wrong as written. A review pointed out that leaving them unamended is the
same defect ADR-0027 itself exists to correct — it was written because recording a carve-out only
at the benchmark layer leaves the ADR-layer invariant reading as absolute to anyone following
AGENTS.md's reading order. Repeating that one ADR later would be worse, not better.

The invariant now reads:

```text
LOCAL_OPERATOR_APPROVAL = REQUIRED_FOR_EVERY_EFFECT_NOT_ADMITTED_BY_AN_ACTIVE_GOAL_LEASE
RUN_AND_APPROVAL = HUMAN_UNLESS_A_LEASE_ADMITS_THE_ACTION
GOAL_LEASE_ADMISSION = DETERMINISTIC_LOCAL_POLICY_OVER_DURABLE_RECORDS
NO_LEASE_CONFIGURED = ADR_0026_UNCHANGED_IN_FULL
```

The last line is the important one. With no lease configured — which is every existing
installation, because the config field did not exist until now — ADR-0026 holds exactly as
written, and that is asserted by a test rather than by this paragraph.

`.claude/rules/human-presence-boundary.md` still tells every agent that reads it that "no
proposal becomes an effect without the operator's authenticated approval". That sentence is
currently accurate only by accident, and becomes false the moment an operator configures a lease.
It cannot be corrected here: that directory is denied to the agent by the harness's own rules, and
a lease cannot grant it either, by design. The corrected text is prepared in the pending `.claude`
patch and needs a human to apply it. **Until it is applied, do not enable a lease in production**
— not because the mechanism is unsafe, but because the rule a future agent reads would be wrong,
and that is exactly the failure this project keeps finding.

## How each security requirement is met

| # | Requirement | Mechanism |
| --- | --- | --- |
| 1 | disabled by default | `goalLease` is an optional coordinator option; absent means `NO_LEASE` |
| 2 | explicit creation | a lease must be inserted deliberately; none exists implicitly |
| 3 | fail closed | missing, expired, revoked, malformed, unparseable and mismatched all deny |
| 4 | bound to identity | session, adapter and workspace root compared exactly, from the record |
| 5 | CAS before consequence | lease re-read per call; `executeQueued` re-checks the base hash |
| 6 | browser content untrusted | the decision reads durable rows, never proposal text |
| 7 | cross-session isolation | unchanged; a lease adds constraints and relaxes none |
| 8 | no self-widening | a lease is immutable once inserted; only revocation mutates it |
| 9 | cannot grant its own policy | `AUTHORITY_FILE_PROTECTED` for configuration, **plus** `SELF_MODIFICATION_REFUSED` for any workspace inside the running gateway's checkout |
| 10 | durable audit | `mutation_authority` + the existing `audit_events` and result hashes |
| 11 | kill switch | consulted on every admission, first, before the lease is even loaded |
| 12 | restart semantics | the lease and its spend are durable; a restart cannot refill a budget |

## What this does not claim

- **It does not contain a same-user adversary.** A lease is a row in a SQLite file, and ADR-0019
  already places someone who can write that file outside the containment claim. This is the same
  boundary as the harness lane, not a new one.
- **It does not make the policy engine the only thing that matters.** Path policy, identity
  checks, rate limits and the execution CAS all still run; the lease is an *additional* gate, and
  removing any of the others would not be compensated for here.
- **A commit-granting lease admits at most one commit.** The HEAD binding is a CAS on history, so
  the first commit moves HEAD and every later proposal's `oldHead` then differs from the bound
  `headSha` and is refused. This fails closed, which is the right direction, but it does not
  match the motivating story of a goal running to completion: a multi-commit goal needs a new
  lease per commit. A review pointed this out and it is a real limitation of v1, not a bug.
- **The commit cycle's tests use a stub backend.** The gate is what is new and what they test.
  The commit machinery itself — drift refusal, the ref CAS, hook containment — is covered
  against a real repository in `git-commit.test.ts`. So the second link of the HEAD chain, the
  backend's own re-observation, is asserted there and not here.

## Decision markers

```text
ADR_0028 = ACCEPTED
GOAL_LEASE = BOUNDED_DETERMINISTIC_LOCAL_POLICY
APPROVER = PURE_FUNCTION_OVER_DURABLE_RECORDS
MODEL_IS_NEVER_THE_APPROVER = TRUE
DEFAULT = DISABLED
MANUAL_HUMAN_MODE = UNCHANGED_AND_STILL_REQUIRED_WHEN_NO_LEASE
AUDIT = POLICY_APPROVED_VS_HUMAN_APPROVED_DURABLY_DISTINGUISHED
GIT_COMMIT_UNDER_LEASE = WIRED, AT_MOST_ONE_COMMIT_PER_LEASE
MAX_LEASE_WINDOW = 12_HOURS
SELF_MODIFICATION = REFUSED_BY_LOCATION
```
