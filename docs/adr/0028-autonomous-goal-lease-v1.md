# ADR-0028: Autonomous Goal Lease v1

Date: 2026-09-21
Status: Accepted
Depends on: ADR-0019, ADR-0023, ADR-0026, ADR-0027
Evidence: `docs/benchmarks/2026-09-21-autonomous-goal-lease-v1-acceptance.md`

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

Additionally, and checked above the path patterns rather than left to them: a lease cannot grant
edits to its own authority. `.claude/`, `.git/`, `docs/adr/`, `AGENTS.md`, `CLAUDE.md`,
`package.json` and `tsconfig.build.json` are refused even under a `**` pattern
(`AUTHORITY_FILE_PROTECTED`). A lease that could rewrite the policy that bounds it is not a bound.

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
| 9 | cannot grant its own policy | `AUTHORITY_FILE_PROTECTED`, above the patterns |
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
- **Git commit semantics are defined but not yet exercised in production.** The bindings and the
  policy support `commit-to-bound-branch` with a HEAD CAS, and the policy is tested; the commit
  coordinator is not yet wired to `admitByPolicy`. Until it is, a lease granting commits grants
  something no code path consumes. That is stated rather than implied.

## Decision markers

```text
ADR_0028 = ACCEPTED
GOAL_LEASE = BOUNDED_DETERMINISTIC_LOCAL_POLICY
APPROVER = PURE_FUNCTION_OVER_DURABLE_RECORDS
MODEL_IS_NEVER_THE_APPROVER = TRUE
DEFAULT = DISABLED
MANUAL_HUMAN_MODE = UNCHANGED_AND_STILL_REQUIRED_WHEN_NO_LEASE
AUDIT = POLICY_APPROVED_VS_HUMAN_APPROVED_DURABLY_DISTINGUISHED
GIT_COMMIT_UNDER_LEASE = POLICY_DEFINED_NOT_YET_WIRED
```
