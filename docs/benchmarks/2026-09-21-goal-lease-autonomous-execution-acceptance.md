# Autonomous Goal Lease — final acceptance

Date: 2026-09-21
Status: **ACCEPTED LOCALLY.** All four criteria met. Nothing inferred.
Base: `b2a3d0a`
Candidate: `1396804`
Decision: ADR-0028. Supersedes the acceptance wording in
`2026-09-20-claude-autonomous-wag-harness-v1-acceptance.md`, which required a final human
Run/Approve proof; the operator replaced that criterion on 2026-09-21.

```text
WAG_LOCAL_OPERATOR = PRIMARY
DESKTOP_COMMANDER  = FALLBACK_ONLY
```

Desktop Commander appears nowhere in this work. It is denied in `.claude/settings.json` and its
MCP server failed to connect for the whole session, so its absence is a fact about the run.

## The criteria, and how each was met

### 1. Bounded Goal Lease execution works autonomously

`npm run test:goal-lease` — the **production assembly**, not a harness. The built CLI spawned as a
separate process over a real stdio transport, a real DevSpace, a real SQLite store, the real
coordinator, the real filesystem backend. Nothing stubbed; the fixture lane is not involved.

One tool call is made — `mutation.preview` — and nothing else:

```text
mutation       PENDING_APPROVAL -> SUCCEEDED, unattended
disk           the file holds the reviewed content, byte for byte
authority row  POLICY_APPROVED, lease_id lease_e2e_acceptance
HUMAN_APPROVED rows in that store: 0
```

**Why this surface.** A lease removes the operator's Approve. Whether it removes *Run* depends on
where the proposal comes from, and Run is a browser-adapter concept — the act of turning an
untrusted page's text into a proposal. On the browser operator runtime a lease therefore removes
only half the gestures, because a human pressing Run is what creates the record. The stdio
surface has no page and no Run, so that is where a lease produces genuinely gesture-free
execution. It had no lease support until this milestone; it does now, with the admission pass,
because the identical gap on the browser runtime was a review finding.

Verified by mutation, not by reading: disabling the admission pass makes the test time out
waiting for an admission that never comes.

### 2. Manual human mode is unchanged when no lease is active

The control test, in the same file, and the more important of the two. The identical assembly with
no `goalLeaseId` — which is every deployment that exists, since the config field did not exist
before this work:

```text
mutation       PENDING_APPROVAL, still, after an interval long enough for several admission passes
disk           untouched
authority row  none at all — admitted by neither
```

A mechanism that quietly changes the default would be worse than no mechanism.

### 3. No unresolved security blockers

Six independent read-only reviews across the milestone, each in its own session. The last, against
the lease, returned eleven findings. Every one is fixed or recorded. Two were things this work
asserted and had not verified, and they are the useful part of the whole exercise:

- **the kill switch failed OPEN.** `fs.existsSync` never throws; it swallows every error and
  returns `false`. The `catch { return true }` arm was unreachable code sitting directly under a
  comment claiming it was the safety property. Measured: an access-denied file and an invalid
  path both returned `false`. The test named "fails engaged" tested presence, absence and
  idempotence, and the file imported `chmodSync` without using it — the residue of the test that
  would have caught it. Now `statSync` with `throwIfNoEntry: false`, separating present, absent
  and unknowable, with the last reading as engaged;
- **nothing in production called `admitByPolicy`.** Configuring a lease attached an option no code
  consulted while the CLI printed "autonomous admission is ENABLED".

The other nine: an unvalidated lease expiry that never expired with `NaN`; authority-file
protection that covered the configuration of authority but not the code enforcing it, now refused
by location; a byte budget that ignored deletion; an authority row written outside its
transaction; spend counted by path name across roots; commits with no authority row; malformed
bindings that threw instead of denying; no lease lifetime ceiling; and an ADR citing an evidence
file that did not exist.

### 4. All repository gates green

At `1396804`, exit codes measured directly rather than through a pipeline:

```text
npm test                     575 tests, 569 pass, 0 fail, 6 todo, 875s   exit 0
npm run typecheck                                                       exit 0
npm run build                                                           exit 0
npm run test:business        1 pass / 0 fail                            exit 0
npm run test:dc-replacement  1 pass / 0 fail                            exit 0
npm run test:goal-lease      2 pass / 0 fail                            exit 0
git diff --check                                                        exit 0
gitleaks 8.30.1  b2a3d0a..1396804  34 commits, 497.04 KB, NO LEAKS      exit 0
dist/  lane absent (correct) · goal-lease + kill switch present
```

The 6 `todo` are the open PreToolUse guard findings. They run, report, and do not fail a gate; a
verified patch for them exists and is unapplied because it was never authorised.

## The rule text, and why a human applied it

`.claude/rules/human-presence-boundary.md` told every agent that no proposal becomes an effect
without the operator's authenticated approval. True only while no lease is configured. Leaving it
would have meant a future agent holding a belief the ADRs no longer support — the exact defect
ADR-0027 exists to correct.

The agent could not fix it: the harness denies writes under `.claude/`, and a lease cannot grant
them either, by design. So the patch was prepared outside that directory, with hashes, and applied
by the operator.

```text
docs/pending/human-presence-boundary.patch  5d5133fbe148cfa02298a9798003140b3ab4fa05fc2d4e7d281a99cb1457574b
resulting rule file                         210becf3015bb993653935457e7c8fe57ce99a514c69c22fe5fee6cea4e90562
verified after application                  MATCH, and byte-identical to the artifact
```

## Cleanup

```text
processes of mine in this worktree     0
WAG runtime / pinned DevSpace          0  (stopped; existed for the superseded proof)
wag-op-3 browser worker                0  (closed; ownership re-proved first)
native host                            0
orphaned test runners                  0  (6 found and stopped — see below)
wag-op-2, another session's worker     never opened, never closed, never touched
node.exe left on the machine           17, none of them mine
E:\AI-BROWSER\wag-acceptance\workspace\ticket-id.js  247c0a24… — as it was found
```

The six orphans dated from 06:38 and 06:46, and are a consequence worth recording: they were
mutation runs interrupted because a test **hung** rather than failed when its guard was removed.
That test is fixed, and the battery now restores under a `trap`, but the orphans sat for five
hours before an inventory found them. Cleanup was by exact PID against command lines containing
this worktree's path; no broad termination was used.

## What this milestone actually produced

The lane, the launcher and the lease are the artefacts. The finding is this:

**Six reviews, and every single one found the same class of defect — a guard written, described
confidently, and reached by no test.** This round it produced a kill switch that failed open
beneath a comment asserting it failed closed, and a feature announced as ENABLED that nothing
ever called. Both were assertions rather than measurements.

Twenty-one mutations across the milestone, each verified to apply before its run, each caught by
the test claiming to cover it. Mutation is the countermeasure. Review did not find these; passing
tests did not find these.

Three incidental lessons, recorded because each cost real time:

- an automated scanner sampled a source file mid-mutation and reported the deliberate mutations
  as CRITICAL authorization bypasses;
- a gate table once reported `EXIT=$?` after a pipeline, which measures `tail` and not `npm`. The
  numbers were right by luck;
- isolated suites passing is not the gate passing. A lane import broke an invariant owned by a
  suite that had not been re-run, and the full suite caught it.

## Residual limitations

```text
LEASE_IS_ENABLED_NOWHERE
```
No deployment configures one. The proof creates a lease in its own temp store and tears it down.

```text
ONE_COMMIT_PER_LEASE
```
The HEAD binding is a CAS on history, so the first commit moves HEAD and later proposals are
refused. Fails closed; does not match a multi-commit goal.

```text
BROWSER_SURFACE_STILL_NEEDS_RUN
```
A lease on the browser operator runtime removes Approve only. Run remains human there, because
Run is what creates the proposal.

```text
SAME_USER_IS_OUT_OF_SCOPE
```
A lease is a row in a SQLite file. ADR-0019 already places whoever can write that file outside
the containment claim.

```text
GUARD_HAS_SIX_OPEN_FINDINGS
```
Unchanged from the previous receipt. A verified patch exists and is unapplied.

## What this does not authorize

Push, PR, merge, remote mutation, release, tag, signing, provider or account actions, paid
purchases, identity verification, or any machine-wide change. No adapter identity, protocol
version or capability profile was altered.
