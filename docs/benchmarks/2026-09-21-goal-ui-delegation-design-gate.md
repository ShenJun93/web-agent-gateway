# Goal UI Delegation v1 — design gate (reopened and repaired)

Date: 2026-09-21
Branch: `feat/goal-ui-delegation-v1`
Scope: the design/acceptance gate that precedes native-host and extension integration.
ADR: `docs/adr/0029-goal-ui-delegation-v1.md` (proposed, **gated** on a human applying the rule patch)
Rule patch: `docs/pending/human-presence-boundary-goal-ui-delegation.md` — **not applied**

The first pass of this gate found a defect in already-committed work and four in its own tests. An
independent adversarial review then reopened it with nine substantive findings, several correct
and one — the governance gap — blocking. This receipt records the repair.

## Gates

```text
npm run typecheck                exit 0
npm run build                    exit 0
delegation suites                102/102 pass  (5 files)
npm run test:delegation-mutations  64 applied, 59 caught, 5 redundant-by-design, 0 survived
npm test (full canonical suite)  see "Full canonical suite" below
```

Suites: `goal-ui-delegation` (19), `goal-ui-delegation-planes` (42), `durable-delegation-state`
(22), `proposal-fingerprint` (13), `goal-ui-delegation-isolation` (6).

The mutation battery is now **reproducible from the repository** — `npm run
test:delegation-mutations`, with the list in `scripts/delegation-mutations.json`. The previous
receipt quoted a number nobody else could check.

## Review findings and their disposition

Every finding is CLOSED with a test, or ACKNOWLEDGED with a reason. Nothing is left open.

### 1. The ADR removed a human gesture and never said who may authorize it — **CLOSED**

The highest finding, and the correct one. ADR-0028 gated itself on a human applying a rule patch;
ADR-0029 did not, while `.claude/rules/human-presence-boundary.md` still said Run "may not be
automated, simulated, or worked around" and fixed `RUN_AND_APPROVAL = HUMAN_UNLESS_A_VALID_LEASE`.
A UI delegation is not a lease, so as the rules stood a `DELEGATED_RUN` violated them.

The review also caught a framing error: the ADR said the design "never touches the UI", which is
true and beside the point. The guard exists to stop Claude *causing* a Run; clicking was merely the
only mechanism it could see.

- `docs/pending/human-presence-boundary-goal-ui-delegation.md`, sha256
  `b814427ad29318535e0b25b63153dc14e149ad271c5cb862545f95101024b49d`, taken over the file with its
  own `sha256(` line removed, since a digest cannot cover itself. The document states the method
  and the value round-trips — checked, after a first attempt did not, because a sentence was
  edited after the hash was taken. **Not applied** — Claude cannot write under `.claude/` and must
  not route around it.
- ADR-0029 opens with the gate: until the patch is applied, do not name a `goalUiDelegationId`.
- `UI_DELEGATION_ISSUANCE = HUMAN_ONLY_AND_OUT_OF_BAND` added to the invariant block in the patch.
- **The mechanism, not just the rule:** `configuredDelegationId`. A delegation row that is not the
  id named in local configuration is **inert**, so a row minted by any route other than the
  human's out-of-band one authorises nothing. Config field `goalUiDelegationId` mirrors
  `goalLeaseId` exactly; naming grants nothing on its own.
- Tests: *a delegation that exists but is not configured authorises nothing*, *configuring one
  delegation does not make a different one live*, *a delegation is inert unless local
  configuration names it*. Mutations: "an unconfigured or non-configured delegation is honoured",
  "an unconfigured delegation may be staged under" — both caught.

### 2. `canonicalProposalFingerprint` was not injective — **CLOSED**

Measured by the reviewer and reproduced here: the length prefix counts UTF-8 bytes and the digest
is over UTF-8, so every unpaired surrogate encoded to the same three bytes as U+FFFD.

```text
{"query":"\ud800"} {"query":"\udc00"} {"query":"�"}  ->  fp_9540a089d37267d8…  (all three)
```

Reachable from page text, where `\uD800` is an ordinary JSON escape, and the distinction survived
the JSON round trip into SQLite — three distinct rows, one identity.

- Unpaired surrogates are now **refused**, as strings and as object keys.
- The preimage is **domain-separated and versioned**: `WAG/proposal-fingerprint/v1`,
  length-prefixed into the preimage like any other string.
- The tuple now includes **session and adapter**, per the reopened scope.
- `proposalFingerprintPreimage` is exported so injectivity is asserted over the **preimage**, not
  the digest.
- Test: *no two distinct field tuples share a preimage* enumerates 7⁵ = **16,807** tuples over an
  adversarial alphabet (empty strings, prefixes of one another, values containing the encoding's
  own tags and separators) and asserts every preimage distinct. Plus a structural corpus for
  arguments. Mutations: bare strings, unsorted keys, dropped domain, dropped session, surrogates
  re-admitted — all caught.
- The docstring no longer claims unqualified injectivity: it claims injectivity over what it
  *accepts*, which is what refusing ill-formed input buys.

### 3. The tamper-evidence claim was unsupported — **CLOSED (as a documentation fix)**

Correct. The stored fingerprint is an unkeyed digest in the same row as the data it covers,
computed by an exported function, so anyone who can `UPDATE staged_proposals SET arguments = ?` can
set `fingerprint = ?` in the same statement. Nothing is "made visible".

- The denial code is renamed `PROPOSAL_TAMPERED` → **`PROPOSAL_INCONSISTENT`**.
- The code comment and the ADR now say what it is: an internal-consistency check that catches a
  partial write and a future code path that edits a row and forgets the column.
- The test is renamed to *a staged row edited behind WAG is refused as inconsistent* and says in
  its body that this is not tamper evidence.

### 4. Renewal could double the budget; `supersededBy` was never read — **CLOSED**

Three non-atomic statements meant a crash between linking and revoking left **two live delegations
for one goal, each with a full budget** — and the comment called that "losing authority is the safe
direction", which described the other branch.

- `renewUiDelegation` is now **one transaction** in the store.
- The policy denies `DELEGATION_SUPERSEDED`; the claim transaction re-checks it.
- Renewal refuses a **revoked** predecessor (it would turn a deliberate stop into a fresh budget)
  and an already-superseded one.
- Tests: *renewal is one transaction, so a goal never has two live delegations*, *a revoked or
  superseded delegation cannot be renewed back into life*, *a superseded delegation cannot be
  renewed, even if its revocation never landed* (which constructs the superseded-but-not-revoked
  row directly, so the guard is reached rather than merely present).

### 5. `maxActions` bounded only the path that gets audited — **CLOSED**

`recordHumanRun` on the browser-reachable plane accepted a proposal staged **under** a delegation,
spending no slot and writing `HUMAN_RUN` — true of the row, false of the work. Reproduced here
before fixing.

- The store refuses `PROPOSAL_IS_DELEGATED`, inside the transaction.
- Tests: *a delegated proposal cannot be run as a human Run*, *a delegated proposal cannot be
  laundered through the human path*. Mutation caught.

### 6. "No unbounded browser write" was false — **CLOSED**

The bound counted `dispatched_at IS NULL`, and running a proposal cleared it, so a stage/run loop
grew the tables without limit. The undelegated branch also validated nothing — not even that the
origin was a URL.

- `MAX_TOTAL_STAGED_PER_SESSION` bounds rows **in any state** per browser context.
- `MAX_OPEN_STAGED_PER_SESSION` still bounds the queue.
- The existing per-caller `proposal-rate-limit` now bounds staging rate (hence `ownerId` on
  `ConnectionIdentity`, so limits key on the tuple the rest of the gateway already uses).
- `tool`, `workspaceId` and `origin` are validated on **both** branches, with the origin parsed and
  required to be exact.
- Tests: *an undelegated stage/run loop cannot grow the store without limit* (runs the loop and
  asserts it terminates), *the open queue is bounded even when nothing is ever run*, *staging is
  rate limited per browser context*, *staging validates its inputs*. Four mutations, all caught.

### 7. The kill switch failed open, was unwired, and blocked the human route — **CLOSED**

Three distinct problems, all correct.

- `killSwitch` is a **required** constructor argument and throws if absent — the Goal Lease paths
  already required theirs; this one had drifted to optional with `?? false`.
- The "shared with the Goal Lease stop" claim is removed from the code comment until the wiring
  exists. **This line originally continued "…and the ADR describes the intent without asserting the
  wiring", which was false — the ADR asserted it. See S-1 below.**
- It no longer blocks **undelegated** staging, because staging is how a human Run's proposal comes
  into existence and the rule file is explicit that the stop must not block the human route.
- Tests: *a dispatch plane cannot be built without a kill switch*, *the kill switch does not block
  the human route*, *the kill switch stops delegated dispatch and delegated staging*. Mutations
  "the kill switch becomes optional again" and "the kill switch blocks the human route too" —
  both caught.

### 8. The plane split was an import boundary, not a capability boundary — **CLOSED**

The decisive finding. `insertUiDelegation` is a public store method, so a plane holding the store
could mint a delegation with an arbitrary goal, controller and eleven-hour window **without
importing the control module** — and all five isolation tests stayed green. Reproduced here: an
11-hour, 999-action delegation created from the object the plane was handed.

- The plane is constructed with a narrow **frozen port** carrying twelve named methods, built by
  enumerating what is allowed rather than deleting what is not.
- The proof is **dynamic**: *the dispatch port carries no issuance method, at runtime* calls each
  forbidden method and asserts a `TypeError`, checks the surface equals the declared list, and
  checks the port is frozen.
- The 4-hour ceiling is now re-checked **inside the claim transaction** too, since the control
  plane is no longer the only thing that could have inserted a row.
- Mutation "the port hands over the whole store" — caught.

### 9. Two "race" tests still raced nothing, and their comments said they did — **CLOSED**

Correct, and the previous receipt overstated it as "Fixed" when a new suite had been *added*
alongside the misleading ones.

- Both misleading tests and their false comments are gone.
- `durable-delegation-state.test.ts` is the transaction-level coverage, with no policy in front of
  it, and its header says why it exists.
- Contention is tested for what actually happens: *a contended claim fails loudly and leaves
  nothing behind*.

### 10–13, 15–17. Smaller findings — **all CLOSED**

- **10.** The store comment claiming it "re-reads every time-varying fact" now enumerates what it
  does re-read and what it does not (session, adapter, tool, origin, workspace — the policy's job).
- **11.** "Exhaustive; none is an error" now says exhaustive over *decisions*, and notes that
  contention raises rather than returning a code.
- **12.** `assertDelegationSchemaShape()` refuses a pre-acceptance store **at open** with a message
  naming the missing columns, instead of failing deep inside an insert. Ordered before index
  creation, because an index on a missing column throws first with an opaque message. The
  constructor now **closes the handle** when schema setup refuses — it was leaking one. Test and
  mutation both present.
- **13.** The ADR and this receipt no longer disagree; both quote the counted total.
- **15.** `stageProposal` validates its inputs at runtime. Mutation caught.
- **16.** The protocol verb extractor is case-insensitive and covers all literals, and a **dynamic**
  test parses requests with extra fields and asserts they are refused rather than ignored —
  including inside `arguments`.
- **17.** The battery is committed and runnable: `npm run test:delegation-mutations`.

### 14. `stageProposal` bounds are TOCTOU — **ACKNOWLEDGED, unchanged**

Correct and benign: two concurrent stages can both pass the count read, so the queue can
over-fill by a small margin. The consequence is over-queueing only — the claim transaction
re-counts under the write lock, so `maxActions` still holds exactly. Making staging transactional
would buy nothing that matters and would put a write lock on the cheapest, most frequent call.

## What the reopened scope added, beyond the review

- **A durable CLAIM transition.** `STAGED → CLAIMED → DISPATCHED → RESULTED`, plus terminal
  `ABANDONED`. The claim is the documented point where a slot is spent, so "zero effect on refusal"
  is now an exact statement rather than an approximate one.
- **`DELEGATED_RUN_REFUSED`.** Durable, with reason code and a `slot_claimed` flag, bounded per
  browser context, carrying ids and never content.
- **Crash recovery, proved.** *restart after CLAIMED cannot silently double-run or resurrect
  authority* and *restart after DISPATCHED cannot re-run or re-claim*. Recovery retires an expired
  claim to `ABANDONED`, releases no budget and never dispatches — the only honest reading of a
  crash between claim and dispatch.
- **Session and adapter in the identity tuple**, per the reopened fingerprint scope.

## Defects the first pass found (retained for the record)

1. **In already-committed work (`b07dc6f`).** A `proposalFingerprint` compared against an
   `expectedProposalFingerprint`, both from the caller. A caller sending the same value twice
   passed. Fixed structurally: WAG computes identity from the row it holds.
2. **The tool allowlist was never really tested** — every refused case differed in the first
   character, so a prefix-match mutation survived. Added `file.readonly`, `file.read.write`,
   `repo.searchx`, `repo.search.destroy`.
3. **An asserted encoding collision was not one** — tags and counts already separated the pairs
   used. Replaced with `{a: 'b'}` against `{ab: ''}`, which genuinely collides without the prefix.
4. **Two "race" tests raced nothing** — see finding 9 above, now fully closed.
5. **A redundancy was described as independence** — see below.

## Second review, after the repair — nine findings, all closed

The repaired gate was re-reviewed independently against every prior finding. All 17 came back
CLOSED. Nine new findings came with them; each is closed below, with a test and a mutation.

Two of them are the same failure class this project keeps producing, and both were in prose I
wrote in the *first* repair — which is worth stating plainly rather than filing quietly.

### S-1 — the ADR asserted kill-switch wiring that does not exist, and this receipt said it didn't

ADR-0029 read: *"The same file the Goal Lease stop uses, so one stop halts both."* There is no such
wiring. Nothing in `src/` constructs the dispatch plane, so nothing points the callback at
`isKillSwitchEngaged`, and `npm run lease:stop` today has no effect on any delegation path.

Worse: this receipt's own disposition of finding 7 claimed *"the ADR describes the intent without
asserting the wiring"*. It asserted it. A receipt describing an ADR's claim as weaker than it is,
is exactly the defect the receipt was written to record.

**Closed:** the ADR now says it is not wired, says what the intent is, and says that making the
argument required is what forces the decision rather than defaulting it.

### S-2 — `abandonExpiredClaims` said "called at startup and periodically" and has no caller

Same shape, smaller blast radius. The docstring described intended wiring as fact; the only
callers are tests, and `CLAIM_TTL_MS` is exported and unread.

**Closed:** the docstring now says it is not yet wired and where the wiring belongs. Crash recovery
is proved at the store API — which is what the tests demonstrate and all this milestone claims.

### S-3 — `attachResult` had no ownership check — **measured**

The one method on the browser-reachable plane with no identity check, twelve lines below
`recordHumanRun`, which has one. The reviewer measured it: a second browser context attached a
result id to another context's audit row, and because the attach is single-use, the legitimate
owner's later attach returned `false` permanently. Cross-context audit poisoning plus a denial.

**Closed:** `attachResult` takes a `connection` and refuses `PROPOSAL_NOT_OWNED`. Test *a result
may only be attached by the context that staged the proposal* covers both halves — the intruder
refused, and the owner still able to attach afterwards. Mutation caught.

### S-4 — the schema check compared column names, not constraints — **measured**

The reviewer built a store with every required column name and no `CHECK`, no `PRIMARY KEY` and no
`FOREIGN KEY`. It opened without complaint, and then accepted a `HUMAN_RUN` row carrying a
delegation id — the thing ADR-0029 calls impossible — plus a bogus `state` and duplicate claim rows.

**Closed:** the check now reads `sqlite_master.sql`, which SQLite stores verbatim, and requires the
constraints each table's guarantees rest on. The ADR's "impossible" is now qualified to what it can
actually mean: exact for a store this code opens, because the constraint is verified rather than
merely created. Test and mutation both present.

### S-5 — the refusal audit was bounded in rows but not in writes — **measured**

400 dispatch attempts with delegation entirely off produced 400 write transactions in 560 ms. The
row cap held; the disk did not. Staging got a rate limit in the first repair; dispatch is the path
that repair did not cover.

**Closed:** `authorizeDelegatedRun` charges its own rate limiter before anything is written, and a
rate refusal writes **nothing at all**. Test asserts the audited attempts are recorded and the rate
refusal is not. Mutation caught.

### S-6 — the Gates block pointed at a section that did not exist

`see "Full suite" below` matched nothing. Closed: the section exists and is named consistently.

### S-7 — a goal could still hold two live delegations, via `issue` — **measured**

Finding 4 closed the renewal route. `issue` enforced nothing: called twice it produced two live
rows for one goal and two full budgets, bypassing the revoked/superseded checks `renew` makes.
`"One goal, one parent delegation"` was a convention, not an invariant.

**Closed:** `issue` refuses a second live delegation for a goal. Live means un-revoked,
un-superseded and inside its window — an expired delegation authorises nothing, so refusing to
replace one would be refusing to replace a corpse. Test and mutation both present.

### S-8 — refusing a pre-acceptance store mutated it first

A store with one pre-acceptance table gained the four it was missing, and only then was the open
refused. **Closed:** the check runs before *any* `CREATE TABLE`, including the unrelated ones, and
a test asserts the refused file gained no tables on the way out.

### S-9 — a throw between claim and dispatch spent a slot and wrote nothing

Contention raises rather than returning a code — deliberately, and pinned by a test. So an
exception there escaped having spent a slot with no refusal row, no `slot_claimed` flag, and a
CLAIMED row with no record of why.

**Closed:** the post-claim region records `DISPATCH_FAILED_AFTER_CLAIM` with `slotClaimed: true`
and rethrows. The failure still propagates; it stops being silent about what it cost. Two tests —
one for the throw, one for the ordinary post-claim refusal — plus a mutation.

### O-2 — `Map`, `Set`, `Date` and class instances all encoded as `o:0:`

`Object.keys` returns nothing for them, so each encoded identically to `{}` and to each other.
Sparse arrays dropped elements while keeping the count. Not reachable through `JSON.parse` or the
strict protocol schemas, and such a row would be permanently undispatchable anyway — but it is the
same silent drop the module refuses for `undefined` one type-layer up.

**Closed:** non-plain objects and arrays with holes are refused. An identity function should not
depend on its caller to stay injective. Test and two mutations.

### O-3, O-4, O-5 — acknowledged

- **O-3.** `goalUiDelegationId` is validated in config and read by nothing, because no module
  constructs the plane yet. Consistent with the ADR gate and "Not done here": the governance
  mechanism exists ahead of the runtime it will bound, which is the safe order.
- **O-4.** `NO_PROPOSAL` vs `PROPOSAL_NOT_OWNED` lets one context distinguish "no such proposal"
  from "someone else's". Proposal ids are 96 random bits; the distinction is not practically
  exploitable and the codes are worth more to an operator reading a refusal.
- **O-5.** `notBeforeMs` was unbounded. Closed anyway — bounded by the same ceiling as the
  window — because a ceiling that only covers duration is half a ceiling.

### The caveat the reviewer recorded, now closed rather than kept

The reviewer noted that the script treated any non-zero exit as CAUGHT, so a mutation that merely
broke the file would score as caught — crediting the mutations that prove least. That is a real
weakness in the measure, so it is fixed rather than filed: `runSuite` now reads the reported test
count, and a run where no tests executed is `INCONCLUSIVE`, not `CAUGHT`.

Re-run under the stricter scoring: **59 caught, 5 redundant, 64 total, 0 inconclusive** — unchanged,
so every catch was already a genuine test failure.

## The five redundant-by-design mutations

Each is an early state read that the single-assignment `UPDATE` in the same transaction also
covers. They survive because both produce the same outcome, and they are kept as backstops against
a change to the isolation level.

The redundancy is **measured, not asserted**: a second connection's `BEGIN IMMEDIATE` is refused in
about a millisecond while one is open, and `BEGIN DEFERRED` is granted — so the lock carries the
property. A mutation that changes the isolation level itself is in the battery and is **caught**.

```text
REDUNDANT the STAGED read is dropped from the claim
REDUNDANT single-assignment dropped from the claim
REDUNDANT the CLAIMED read is dropped from the dispatch
REDUNDANT the STAGED read is dropped from the human run
REDUNDANT the superseded read is dropped from the renewal
```

## Full canonical suite

```text
npm test    685 tests · 679 pass · 0 fail · 6 todo · exit 0 · 923.6s
```

The six `todo` entries are the pre-existing open findings in `test/claude-harness-guard.test.ts`,
marked `todo` so they stay visible without failing the run. They predate this milestone, belong to
the outstanding guard patch, and are untouched by it — that file is not in this change set.

## Boundaries

`.claude/` is untouched by this milestone — no change to the PreToolUse guard, the settings deny
list, the computer-use read tier, or any rule file. Verified with
`git diff a388d0a...HEAD -- .claude/` and `git status --porcelain -- .claude/`, both empty. The rule
change this ADR needs is a **pending artifact for a human to apply**, not an edit.

No browser issuance path exists: no v4 verb reaches issuance, no runtime module imports the control
plane, and the browser-reachable port has no issuance method at runtime.

## Not done here

Native-host protocol, the extension request path, the end-to-end zero-manual-Run proof, and the
restart/reconnect proof against a live browser. Those follow this gate, and only after a human
applies the rule patch.
