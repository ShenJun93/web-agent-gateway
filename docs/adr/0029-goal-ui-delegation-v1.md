# ADR-0029 — Goal UI Delegation v1

Status: proposed
Date: 2026-09-21
Supersedes nothing. Constrained by ADR-0019, ADR-0022/0023, ADR-0026, ADR-0027, ADR-0028.

> **Gate.** This ADR removes a human gesture, so it does not take effect until a human applies
> `docs/pending/human-presence-boundary-goal-ui-delegation.md` to the rule file. Until then, **do
> not name a `goalUiDelegationId` in any runtime configuration**. With none named every delegation
> row is inert, ADR-0026 holds in full, and Run stays human. This is the gate ADR-0028 set for the
> Goal Lease, for the same reason: the code that honours an authority must not precede the rule
> that says who may grant it.

## Context

An active `/goal` should be able to complete work without a person clicking Run for every
proposal. ADR-0026 fixed `RUN_AND_APPROVAL = HUMAN`; ADR-0028 added a Goal Lease that can admit an
*effect* without a human approving it. Neither addresses Run itself.

The obvious implementation is to make the extension click its own button. That must not be built,
for a reason that is a fact about the architecture rather than a matter of taste:

> **The human gate for Run currently lives inside the browser.** The gateway receives
> `native.postTool(request)` and has no way to distinguish a human-clicked dispatch from an
> extension-originated one.

So an auto-clicking implementation would be indistinguishable, in the durable record, from
bypassing the gate, and every audit afterwards would be inference rather than fact.

## Decision

Goal UI Delegation is a **second authority WAG evaluates outside the browser**, over records the
browser cannot write. Nothing clicks anything.

```text
human       issues one bounded delegation out of band, and names it in local configuration
extension   stages a parsed candidate — inert — and later asks for it to be dispatched
WAG         loads both records, derives every fact itself, admits or refuses
audit       DELEGATED_RUN / DELEGATED_RUN_REFUSED / HUMAN_RUN, all durable and distinct
```

**A delegation lifts Run only. It never lifts Approve.** A proposal it admits is still a proposal:
the effect needs the operator's authenticated approval or an active Goal Lease, exactly as before.
The two authorities are independent and neither implies the other.

### Three trust classes

| input | written by | trust |
|---|---|---|
| the delegation record | the control plane, out of band | authority |
| the staged proposal | the browser, then immutable and inert | bounded data |
| the connection identity | WAG, at admission | authority, unforgeable by a message |

### The browser asserts nothing

A dispatch request is **two opaque references**:

```ts
{ delegationId, proposalId }
```

No goal, no controller, no expiry, no budget, no fingerprint, no authority label, no state. A field
that is not in the message cannot be forged in it. `parseDispatchRequest` **refuses** a request
carrying anything else rather than ignoring the extras, so an attempt appears as a denial. The v4
protocol is `.strict()` throughout and rejects unknown fields for the same reason — verified by
parsing, not by grepping for `.strict()`.

The delegation id is a *reference, not a credential*: holding it grants nothing.

### Naming is what makes a row live

A delegation that exists in the store but is **not the id named in local configuration is inert**.
This is the mechanism that keeps issuance a human act despite a row being just a row: the control
plane is the operator's tooling, and a row that arrived by any other route authorises nothing.

### WAG computes proposal identity

`canonicalProposalFingerprint` derives identity from the stored row over six fields — tool,
workspace, origin, **session, adapter** and canonically-encoded arguments — and never accepts one
over the wire. The preimage is domain-separated and versioned (`WAG/proposal-fingerprint/v1`),
tagged and length-prefixed, with no delimiter and no concatenation of caller-controlled values, so
it is parseable and therefore injective over what it accepts. Ill-formed strings are refused
rather than encoded.

Recomputing it at dispatch is an **internal-consistency check**: it catches a partial write and a
future code path that edits a row and forgets the column. It is **not tamper evidence** — the
digest is unkeyed and lives in the row it covers, so anyone who can edit the arguments can
recompute it with the exported function. An earlier draft claimed the edit was "made visible". It
is not, and ADR-0019 already places that adversary outside the containment claim.

### The state machine

```text
STAGED ──claim──▶ CLAIMED ──dispatch──▶ DISPATCHED ──result──▶ RESULTED
   │                  │
   │                  └──abandon (claim TTL)──▶ ABANDONED   [terminal]
   └──human run──▶ DISPATCHED ──result──▶ RESULTED
```

Every transition is a single-assignment `UPDATE ... WHERE state = '<previous>'` whose row count
must be one. **CLAIMED is the documented point at which a budget slot is spent.** A refusal before
it leaves nothing at all; a refusal after it leaves the slot spent, and the refusal row says so.

Recovery retires an expired claim to ABANDONED. It deliberately does not release the slot and
deliberately does not re-dispatch: WAG cannot know whether a dispatch in flight reached anything,
so the only honest reading of a crash there is "spent and over". Resurrecting it would be the
silent double-run the state machine exists to prevent.

### The transport: a new revision, narrower than the one it sits beside

Delegated dispatch speaks **protocol v5**, `browser.chatgpt.native.delegation.v5`, as a parallel
file to v4 rather than an edit of it. v4 is frozen, and the freeze exists for this case: adding
these verbs to v4 would give every existing v4 session a capability it was never admitted for.

The identity earns its keep twice. A delegation binds `adapterId`, so a delegation issued for v5
cannot be used by a v4 session, and a v4 session cannot speak these verbs at all. The isolation is
structural rather than a check someone has to remember.

**v5 is narrower than v4, not wider.** There is no `tool.call` on it. On v4 the browser names a
tool and its arguments and the gateway runs it; here the browser stages a candidate, which is
inert, and later asks for it by reference — so the tool that runs is the one in the stored row, and
the dispatch message has no tool, no arguments, and no way to change what was staged. That is a
reduction in browser authority, which is why this revision needs no stronger-isolation decision
under ADR-0019.

```text
hello · session.bind · session.unbind · ping · verbs.list · run.stage · run.dispatch · run.result
```

`run.dispatch` carries two opaque references. `run.stage` carries the candidate, which is bounded
data: every value in it is compared against the bindings and can only narrow what is allowed.
Authority is resolved server-side from the staged row — the browser chooses what to *ask for*,
never which authority applies.

The router is the seam, and its one job is that the message contributes nothing but references.
Every envelope carries a `sessionId` because the framing needs one to route; the router **never
uses it as identity**, comparing it against the admitted connection and refusing a mismatch. A
field that is routable, plausible and attacker-chosen is worse than useless without that
comparison, and with it is a routing hint that has to agree with a fact.

### The capability boundary is an object, not an import graph

The dispatch plane is constructed with a narrow **port**: a frozen plain object carrying twelve
named methods. It is not handed the store.

This replaces a claim that did not hold. An earlier draft gave the plane `SqliteDurableStore` and
called the module split structural proof — but `insertUiDelegation` is a public store method, so
the plane could have minted a delegation with an arbitrary goal, controller and eleven-hour window
**without importing the control module**, and every import-pinning test stayed green. The boundary
is now checked by calling the port and watching the forbidden methods be absent.

### Audit

`run_authority` holds one row per Run, with a `CHECK` making it impossible for a `HUMAN_RUN` row to
carry a delegation or a `DELEGATED_RUN` row to omit one. "Impossible" is exact for a store this
code opens: the constraint is verified at open from `sqlite_master.sql`, not merely created, so a
store whose table has the right column names and no constraints is refused rather than trusted.

A proposal staged under a delegation **cannot** be recorded as a human Run — letting it through was
a measured hole that ran delegated work while spending no slot and writing a row saying nothing
delegated it.

`delegated_run_refusals` holds one row per refused attempt with its reason code and whether a slot
was spent. It is bounded per browser context, because an audit the browser can drive is a write
the browser can drive.

Both hold ids, a fingerprint and a result id — never arguments, page text or workspace content.

### Bounds

```text
delegation window      4h ceiling, checked at issue, at use, and inside the claim transaction
budget                 maxActions, counted from durable CLAIM rows
delegated queue        a delegation may not stage more than its maxActions
open queue per context MAX_OPEN_STAGED_PER_SESSION
total per context      MAX_TOTAL_STAGED_PER_SESSION  (the open bound recycles; this one does not)
staging rate           the existing per-caller proposal rate limit
dispatch rate          the same limiter, separately budgeted; a rate refusal writes nothing at all
refusal rows           MAX_REFUSAL_ROWS_PER_SESSION, pruned in the writing transaction
live delegations       one per goal; `issue` refuses a second, `renew` is how one is replaced
start offset           bounded by the same 4h ceiling as the window
```

### The kill switch

It is a **required** constructor argument, not an optional one: an optional callback read as
`?? false`, so a construction site that forgot it silently disabled the stop for the whole
delegated path.

**It is not yet wired.** Nothing in `src/` constructs the dispatch plane, so nothing points that
callback at `isKillSwitchEngaged` the way the lease runtimes do, and `npm run lease:stop` today
halts the lease paths and has no effect on any delegation path. The *intent* is that the runtime
which wires the plane points it at the same file, so one stop halts both — and making the argument
required is what forces that decision to be made rather than defaulted. An earlier draft of this
section stated the shared wiring as fact; a review caught it, and it was the same
confident-prose-over-absent-mechanism failure this project keeps finding.

It stops delegated staging and delegated dispatch. It deliberately does **not** stop the human
route — staging is how a human Run's proposal comes into existence, and someone stopping runaway
automation must still be able to act themselves.

## What this does not do

It grants no consequential tool by itself: a delegation carrying `mutation.preview` or
`git.commit` is a separate decision, and the effect still needs approval or a lease.

It does not edit the PreToolUse guard, the computer-use read tier or the settings deny list —
`.claude/` is untouched. But the honest framing, which an earlier draft of this ADR got wrong, is
**not** "this never touches the UI so the guard is irrelevant". The guard exists to stop Claude
*causing* a Run; clicking was merely the only mechanism it could see. This builds a mechanism it
cannot see. That is legitimate only because the authority comes from a human out of band and is
inert unless a human names it — which is why the rule patch is a gate on this ADR rather than a
footnote to it.

## Residual risk, stated rather than hidden

**WAG still cannot verify that a human clicked.** `HUMAN_RUN` means exactly "no delegation
authorised this" — what WAG can know — not "a person was present". An extension that lied would
not be caught. True before this ADR and true after; what changes is that the honest path is
explicit and separately recorded.

**A page influences what gets staged.** The content script parses assistant turns, so page content
still determines which in-scope proposals exist. A delegation cannot be widened by page content,
but within its bounds the page's influence over *which* proposal is staged is unchanged from
today's Run. The budget, the queue caps and the rate limit bound the blast radius.

A per-delegation staging token was considered and **rejected**: it would defend a path already
closed by extension isolation, at the cost of putting a secret in a design whose claim is that the
browser holds none.

**Three guards are redundant with each other.** Under `BEGIN IMMEDIATE`, the single-assignment
`UPDATE` and the early state read cover the same case; mutation testing confirms neither is
individually observable. They are kept as backstops against a change to the isolation level, which
is pinned by its own test. Recorded because calling them three independent defences would be false.

## What is still unwired, and what activation therefore actually takes

An earlier draft of this section said activation was "two human steps and no code change: apply the
rule patch, then name a `goalUiDelegationId`". That is false, and the same paragraph said so two
sentences earlier — a review caught the contradiction. Doing those two things today changes
nothing observable, and an operator who did them would go looking for what they got wrong.

**The two human steps are necessary and are the gate.** They are not sufficient. What is still
missing, measured rather than estimated:

```text
nothing in src/ constructs the dispatch plane or the router   only the fixture lane does
goalUiDelegationId is parsed and read by no module            src/private-config.ts:50
the native host speaks v4 only                                no v5 frame route exists
the shipped extension loads only the v4 cores                 the v5 core is not imported
abandonExpiredClaims has no caller                            a crash leaves a CLAIMED row unreaped
v5 has no verb that records a human Run                       recordHumanRun is routed by nothing
```

The last two matter most for an operator. Without a reaper, a crash between CLAIM and DISPATCH
strands a slot permanently. Without a human-Run verb, a v5 session can stage on the human path and
then have no way to Run it — so v5 today is delegated-only, and a session that wants the human path
must still use v4.

So the honest statement is: **the authority model and its transport are complete and proved; the
runtime wiring is not built.** The gate is the right place to stop regardless, because the wiring
is exactly the work that should not be done speculatively ahead of the rule that permits it.

## Evidence

See `docs/benchmarks/2026-09-21-goal-ui-delegation-design-gate.md` for the measured gate, the
adversarial review findings and their disposition, the transport, the fixture-lane end-to-end
proof, and the mutation battery.
