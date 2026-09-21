# WHOLE_WAG_REUSE_CLOSURE

2026-09-21. Branch `feat/goal-ui-delegation-v1`, post-human-patch tree. Nothing pushed.

Audit of the current feature diff **and** the WAG architecture it sits in, against the AGENTS.md
reuse order:

```text
NATIVE -> STANDARD -> PROVEN OSS/SERVICE -> COMPOSE -> WRAP -> EXTEND -> BUILD
```

The question asked of every subsystem was not "could this be an npm package" but "is this the
highest rung that actually holds the property WAG needs". Two rungs were skipped and are repaired
below; several BUILD-news are justified and stay; three candidate reuses are rejected with reasons
rather than adopted to improve a ratio.

**Verdict: `WHOLE_WAG_REUSE_CLOSURE = PASS`** — with two repairs applied and every remaining
BUILD-new justified in the table at the end.

---

## 1. What is already reused, and at which rung

The dependency surface is four runtime packages. That is the headline number: WAG is mostly
NATIVE + STANDARD, and its own code is the authority layer.

| Concern | Rung | What supplies it |
| --- | --- | --- |
| Tool surface, client, server, in-process transport | PROVEN OSS | `@modelcontextprotocol/{client,server,node}` v2. The delegated executor runs the **same** `createBrowserOperatorAdmittedMcpServer` a clicked Run reaches, over `InMemoryTransport.createLinkedPair()` — so a delegated Run and a human Run cannot drift, because they are the same function. |
| Protocol parsing, schemas, strict rejection | PROVEN OSS | `zod` v4, `.strict()` on every envelope. v5 reuses **v4's own per-tool argument schemas** by building a v4 envelope and parsing it, rather than restating eleven schemas. |
| Durable state, transactions, constraints | NATIVE | `node:sqlite` `DatabaseSync`. `BEGIN IMMEDIATE`, `CHECK`, foreign keys, single-assignment `UPDATE ... WHERE state = '<prev>'`. |
| Identity, digests, randomness | NATIVE | `node:crypto` — `randomUUID`, `randomBytes`, `sha256`. |
| Test runner | NATIVE | `node:test`. No jest/vitest/mocha. |
| Native-host executable | NATIVE + PROVEN OSS | Node SEA (native) built with `esbuild`, injected with `postject`, PE metadata via `resedit`. |
| Native messaging transport | STANDARD | Chromium's published native-messaging framing (4-byte LE length + UTF-8 JSON), 62 lines. |
| Workspace open / read / write execution | COMPOSE | DevSpace, through the accepted executor port. WAG does not reimplement file access. |
| Git execution | COMPOSE | The real `git` binary through one policy (`safe-git.ts`), not a reimplementation. |
| Browser | COMPOSE | Chromium native messaging + Edge. WAG ships an extension, not a browser. |
| Security framing | STANDARD (informative) | OWASP ACS and the Agentic Top 10 are cited in `docs/research/2026-09-17-wag-webchat-local-coding-mission-lock.md` as the rationale for an inspectable, traceable authority boundary. They are a design influence, not a runtime dependency, and this receipt does not claim conformance to either. |

---

## 2. Duplicate / reimplementation search

Searched across the whole tree, not only the diff, for each category named in the mandate.

| Category | Method | Result |
| --- | --- | --- |
| Identity | every `session_`/correlation mint and compare | One mint (`getOrCreateAdapterSession`), one hash. No duplicate. |
| Canonicalization | every structural encoder | One: `proposal-fingerprint.ts`. Plus one weaker, domain-separated encoder in `delegatedRunResultId` — **examined, kept, justified** (§4). |
| Fingerprinting | every `createHash('sha256')` site (13) | 11 are plain content hashes of a string (file bytes, plan text, tokens) — not structural encoders, so not duplicates. 2 are structural, covered above. |
| Policy evaluation | every evaluator | Two, deliberately: `evaluateGoalLease` (Approve), `evaluateDelegatedRun` (Run). Separate because they bound different gestures; ADR-0029 now states `GOAL_LEASE_SCOPE = APPROVE_ONLY_NEVER_RUN`. |
| **Revocation / expiry** | every `expiresAt` / ceiling comparison | **FOUND: four copies.** Repaired — §3.1. |
| Budgets | every spend count | `COUNT(*)` over durable rows, inside the write lock, per authority. No duplicate counter. |
| Durable state machines | every `UPDATE ... WHERE state` | Five tables, one shared *idiom*, no shared code. Extracting a generic transition helper over five differently-shaped tables would add indirection and remove no duplicate. Not a finding. |
| **Replay / idempotence** | every dedupe path | **FOUND: enforced only in application code** where SQLite can hold the invariant. Repaired — §3.2. |
| Transport framing | every encoder/decoder | One (`native-framing.ts`) shared by v3/v4/v5. No duplicate. |
| Native-host lifecycle | every build/spawn path | v4 and v5 are parallel build scripts by design, so building v5 cannot alter the signed v4 artifact. Deliberate, per the frozen-adapter rule. |
| Git execution | every `spawn`/`execFile` of git | One policy (`SAFE_GIT_BASE_ARGS` + `buildSafeGitEnv`). No second path. |
| Audit / evidence | every authority row | One table per authority, distinguishable by record. No duplicate ledger. |
| Adapter/protocol/link files | v3/v4/v5 parallel families | **Intentional, not duplication.** `wag-primary-operator.md`: adapter identities are frozen and "a session never gains a successor's authority by talking a newer dialect". Deduplicating them would couple frozen surfaces — the opposite of the accepted property. |

---

## 3. Findings and repairs

### 3.1 Four copies of "is this delegation live" — COMPOSE was skipped

The same nine questions — malformed bindings, revoked, superseded, finite clock, finite window,
window that begins before it ends, the 4h ceiling, not-yet-valid, expired — were being asked in
four places:

```text
evaluateDelegatedRun        the policy                          reason: it is the decision
stageProposal               a fail-fast                         reason: documented convenience
claimDelegatedDispatch      inside the write transaction        reason: a row the control plane
                                                                        never wrote must not pass
resolveDelegatedGoal        the effect path                     reason: none. A fourth copy.
```

The first three re-ask deliberately, at their own layer, for stated reasons. The fourth was written
during *this* milestone and had no reason beyond nobody having looked.

**Copies of a liveness predicate are how a revocation ends up honoured in three places and missed in
the fourth.** Repaired by extracting `delegationLivenessDenial(delegation, now)` from the policy and
composing it in both callers. The extraction is behaviour-preserving for the policy — 102 delegation
and composition tests pass unchanged — and strictly *stricter* for the provenance resolver, which
previously validated the bindings' shape but not their contents and never checked that the clock
itself was finite.

Three mutations pin it, and four existing mutations were retargeted onto the shared predicate rather
than left pointing at deleted lines.

### 3.2 The replay invariant was application-only — NATIVE was skipped

`PROPOSAL_REPLAY` was enforced by a `SELECT` inside `claimDelegatedDispatch`. Correct, and inside
`BEGIN IMMEDIATE`, but it is an *invariant* that SQLite can hold directly and was not being asked
to:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_claims_fingerprint
  ON delegation_claims(delegation_id, fingerprint);
```

Both are kept, deliberately: the `SELECT` gives an operator `PROPOSAL_REPLAY` instead of a
constraint error, and the index means a second insert path added later cannot quietly reintroduce
double-spending.

**Migration consequence, stated because this repository has no migration framework by design:** a
store already holding two claims for one `(delegation, fingerprint)` will fail to open. That is
correct — such a store has a double-counted budget — and it cannot arise here. Measured, not
assumed: no WAG store exists on this machine at the configured `statePath`, and `delegation_claims`
has never been written outside a temporary directory.

### 3.3 A test that proved the wrong thing, found by the repair

The test written to prove the new index is load-bearing inserted a claim row naming a proposal id
that did not exist, and asserted the insert threw with `/UNIQUE|constraint/i`.

It passed — on a **FOREIGN KEY** error. It proved the table had a foreign key.

Found by mutating `UNIQUE` away and watching the test still pass. Repaired: the test now stages a
second real proposal so the foreign key is satisfied, matches `/UNIQUE/i` specifically, and adds a
control insert with that row's own fingerprint to show what refused was the uniqueness and not the
insert. The mutation is now CAUGHT.

---

## 4. Candidate reuses considered and rejected, with reasons

Rejecting a reuse is a decision that needs a reason, so each is recorded rather than omitted.

**JCS (RFC 8785) for canonicalization.** `proposal-fingerprint.ts` is a tagged, length-prefixed,
domain-separated, versioned preimage — strictly stronger than JCS, which canonicalizes JSON
*serialization* and still produces delimited text with no type tags, no byte-length prefixes and no
domain separation. Two collisions the module has already fixed illustrate the gap: a bare key/value
merge (`{a:"b"}` vs `{ab:""}`) and unpaired surrogates encoding identically to U+FFFD, reachable
from page text because `\uD800` is an ordinary JSON escape. JCS would not have given the second. The
*hash* is NATIVE `node:crypto`; only the preimage is BUILD, and it is the part with the property.

**A second, weaker encoder in `delegatedRunResultId` — kept.** It length-prefixes differently and,
unlike `encodeString`, does not refuse ill-formed content; it names a result "by its absence rather
than throwing". Composing the strict encoder would turn a tool's odd output into a failed run on the
one path whose job is not to throw. It is safe to be weaker because it is domain-separated and
covers the proposal id and fingerprint, both already unambiguous, and a proposal can only ever have
one result attached. Documented rather than refactored.

**OPA / Cedar / a policy DSL for the two approvers.** Rejected. Both approvers must be pure,
synchronous, I/O-free and *trivially reviewable* — "Claude is never the approver. The page is never
the approver" is the security property, and a policy engine makes the approver a program someone can
edit, plus a WASM or native runtime dependency. Roughly ten predicates over two durable records do
not need a language. This is also the direction OWASP ACS points: inspectable and traceable.

**JWT / macaroons / biscuits for grants.** Rejected on correctness, not taste. Those are *bearer*
credentials designed to be verified without consulting state — which is precisely the property WAG
must not have. Every fact is re-read from a durable row immediately before the consequence so that
revocation is instant; §3.1's repair exists to make that true in one more place. An embedded expiry
cannot be revoked.

**`isomorphic-git` or a JS git implementation.** Rejected. WAG's claim is exact-effect semantics
against the user's real repository — hooks, config, plumbing behaviour and all. Substituting a
reimplementation would *reduce* fidelity. This is the mandate's own clause: do not refactor accepted
exact-effect semantics to increase OSS usage.

**`minimatch` / `picomatch` for lease path patterns.** Rejected. `matchesPattern` is written with
two pointers and one remembered star — no recursion, no backtracking tree — because a lease pattern
is attacker-adjacent input on a path that decides whether a file is written. A regex-compiling glob
library adds a ReDoS surface to the approver. The linearity is the feature.

**`limiter` / `bottleneck` for rate limiting.** Rejected, and this is the *weakest* justification
here and is labelled as such. `proposal-rate-limit.ts` is 56 lines, needs injectable time for
deterministic tests, and keys on the gateway's caller tuple. A dependency would be defensible; the
existing module is small, tested and shared by both planes, so the churn is not.

**OpenShell / MXC.** Named in the mandate; no referent found in this repository, its ADRs, its
research notes or its dependency surface, and no accepted upstream primitive of either name is
recorded. Rather than guess at what was meant, this is recorded as **not assessed**. If either names
a specific primitive, point me at it and it gets the same treatment as the rows above.

---

## 5. BUILD-new subsystems, each justified

Every module in the feature diff that is genuinely new code rather than composition:

| BUILD-new | Why not a higher rung |
| --- | --- |
| `goal-ui-delegation.ts` (policy + `delegationLivenessDenial`) | The authority itself. No standard or package decides "may this page's text become a proposal, under this human's bounded grant". Must be pure and reviewable — see the OPA rejection. |
| `goal-lease.ts` (policy, `matchesPattern`, composition gate) | Same, for Approve. The glob matcher is BUILD for a stated ReDoS reason. |
| `delegated-run-provenance.ts` | 80 lines, and after §3.1 it is mostly composition: one durable read plus the shared liveness predicate plus two binding comparisons. |
| `proposal-fingerprint.ts` | The preimage encoder. Justified against JCS above; the hash is NATIVE. |
| `goal-ui-delegation-dispatch.ts` (the plane + the narrow port) | The capability boundary is a frozen object with no issuance method at runtime. That is a WAG-specific authority shape, not a generic DI pattern. |
| `delegated-dispatch-router.ts` | Maps one wire envelope to one plane call and adds no policy. Thin by design; a generic router would add the branching this file exists not to have. |
| `delegated-run-executor.ts` | Orchestration only — it calls the MCP server (COMPOSE) and the router, and has no branch that can admit what the router refused. |
| `delegation-claim-sweeper.ts` | ~1 screen. A cron/queue package for one interval that never refunds a slot would be more moving parts than the thing it runs. |
| `native-framing.ts` | STANDARD implementation of Chromium's published format. 62 lines, no dependency worth adding. |
| `proposal-rate-limit.ts` | Weakest justification; stated as such above. |
| `path-policy.ts`, `goal-lease-kill-switch.ts`, `safe-git.ts` | WAG-specific exact-effect semantics the mandate explicitly protects: workspace ownership, the file-backed stop that reads as engaged when it cannot be read, and one git execution policy. |

---

## 6. What was deliberately not changed

Per the mandate, and re-verified as intact after both repairs:

```text
WAG-specific workspace ownership            unchanged
local Goal Lease / UI Delegation authority  unchanged in scope; §3.1 is a refactor, not a widening
exact proposal/effect binding               unchanged
CAS / stale / replay rejection              strengthened by §3.2, semantics identical
bounded mutation / Git semantics            unchanged
durable evidence and recovery               unchanged
```

No accepted effect semantics were altered to improve a reuse ratio. Both repairs are strictly
narrowing or behaviour-preserving, and both are pinned by mutations.
