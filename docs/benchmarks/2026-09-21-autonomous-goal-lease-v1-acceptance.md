# Autonomous Goal Lease v1 — acceptance

Date: 2026-09-21
Status: **ACCEPTED LOCALLY** for the mechanism; **NOT ENABLED** in production, deliberately.
Base: `4795038`
Candidate: `2e5adaa` and the ADR corrections that follow it
Decision: ADR-0028. Related: ADR-0019, ADR-0022, ADR-0023, ADR-0026, ADR-0027

```text
WAG_LOCAL_OPERATOR = PRIMARY
DESKTOP_COMMANDER  = FALLBACK_ONLY
```

## What was authorised, and what was built

The operator authorised a bounded autonomous authority mode so that continuous goal execution
would not need a human gesture per action, with the explicit constraint that the existing Run and
Approve buttons must **not** be automated or simulated, and that the model must never be the
approver.

What was built is a separate deterministic mechanism. `evaluateGoalLease` is a pure, synchronous,
I/O-free function over two durable records. It shares no code with the operator server; the
operator server does not know leases exist; and with no lease configured every path behaves
exactly as it did before.

## Acceptance criteria

| Criterion | Result |
| --- | --- |
| autonomous mutation cycle, no Run/Approve | pass |
| autonomous Git commit cycle within lease | pass, with a stub backend and a one-commit limit — see *Limitations* |
| out-of-scope file denied | pass, `PATH_NOT_GRANTED` |
| out-of-scope tool denied | pass, `TOOL_NOT_GRANTED` |
| expired lease denied | pass |
| revoked lease denied | pass, and revocation is one-way |
| wrong workspace / session denied | pass, three distinct codes |
| five concurrent admitted sessions isolated | pass, all twenty cross pairings refused |
| malicious browser prompt cannot widen the lease | pass, budget unchanged after the attempt |
| manual human mode unchanged | pass, with no lease *and* with the kill switch engaged |
| POLICY_APPROVED vs HUMAN_APPROVED durably distinguished | pass, for mutations and commits |
| independent security review, zero unresolved blockers | see below |
| full repository gates | see below |

## The independent security review

One review, read-only, in its own session, against `cce97e7..3c2eafb`. It returned eleven
substantive findings. **Two of them were things this work asserted and had not verified**, and
they are the reason the review was worth more than the tests:

1. **The kill switch failed open.** `fs.existsSync` never throws — it swallows every error and
   returns `false` — so the `catch { return true }` arm was unreachable code sitting directly
   under a comment claiming it was the safety property. A switch file that existed but could not
   be stat'd read as *not stopped*. Measured on this machine: an access-denied file and an
   invalid path both returned `false`. The test named "fails engaged" tested presence, absence
   and idempotence, and never that. The file even imported `chmodSync` and never used it — the
   residue of a test that was contemplated and dropped.

2. **Nothing in production called `admitByPolicy`.** Configuring a lease attached an option that
   no code consulted, while the CLI printed "autonomous admission is ENABLED". The feature the
   commit message described did not exist.

The other nine, all fixed: a lease whose stored expiry was not a number never expired; the
authority-file protection covered the configuration of authority but not the code enforcing it;
the byte budget counted only insertions, so shrinking a 32 KiB file cost one byte; the authority
row was written outside the transition's transaction; spend counted distinct path *names* across
multiple roots; commits had no authority row at all; malformed bindings threw instead of denying;
there was no ceiling on a lease's lifetime; and both ADR-0028's evidence link and its markers
were wrong.

Zero unresolved blockers: every finding is fixed or recorded below.

## Evidence

```text
test/goal-lease-policy.test.ts        12 pass   the pure policy, every denial code
test/goal-lease-acceptance.test.ts    17 pass   the cycles and the denials, end to end
test/goal-lease-commit.test.ts         7 pass   the Git gate
test/goal-lease-isolation.test.ts      7 pass   five sessions, injection, the stop
test/goal-lease-review-fixes.test.ts  10 pass   one per review finding
                                      53 pass / 0 fail
```

### Mutation testing, not observation

Ten mutations against `goal-lease.ts` and `durable-store.ts`, each verified to apply before its
run and each caught by the test claiming to cover it: the kill switch, revocation, expiry, path
patterns, the tool allowlist, the session binding, authority-file protection, the file budget,
and both authority-recording paths.

This matters because the defect this project keeps rediscovering is a guard that reads
convincingly and is reached by nothing. Two incidental findings from running the battery:

- an automated scanner sampled `goal-lease.ts` *mid-mutation* and reported two CRITICAL
  authorization bypasses. They were the deliberate mutations, transiently on disk. The battery
  now restores under a `trap` so an interrupted run cannot leave a disabled guard where the next
  reader finds it — which had already happened once;
- a first attempt at the battery mis-escaped a shell variable and produced ten empty results.
  Worthless rather than wrong, but it is exactly the shape of evidence that gets mistaken for a
  pass, so it is recorded.

## Limitations, stated rather than implied

```text
NOT_ENABLED_IN_PRODUCTION
```
No lease is configured anywhere. The config field did not exist before this work, so every
existing installation is unchanged and still requires the operator's Approve for every effect.

```text
RULE_TEXT_IS_WRONG_UNTIL_A_HUMAN_FIXES_IT
```
`.claude/rules/human-presence-boundary.md` still states that no proposal becomes an effect
without the operator's authenticated approval. That is accurate only while no lease is
configured. The agent cannot correct it — the harness denies writes under `.claude/`, and a lease
cannot grant them either, by design — so **a lease should not be enabled in production until the
pending `.claude` patch is applied by a human.**

```text
ONE_COMMIT_PER_LEASE
```
The HEAD binding is a CAS on history, so the first commit moves HEAD and every later proposal is
then refused. This fails closed, but a multi-commit goal needs a lease per commit, which does not
match the motivating story.

```text
COMMIT_TESTS_USE_A_STUB_BACKEND
```
The gate is tested; the commit machinery is covered against a real repository elsewhere. The
second link of the HEAD chain — the backend's own drift refusal — is therefore asserted in
`git-commit.test.ts` and not here.

```text
SAME_USER_IS_OUT_OF_SCOPE
```
A lease is a row in a SQLite file. ADR-0019 already places whoever can write that file outside
the containment claim, and this does not move that line.

## What this does not authorize

Push, PR, merge, remote mutation, release, tag, signing, provider or account actions, paid
purchases, identity verification, or any machine-wide change. No adapter identity, protocol
version or capability profile was altered.
