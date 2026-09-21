# ADR-0029 — Goal UI Delegation v1

Status: proposed
Date: 2026-09-21
Supersedes nothing. Constrained by ADR-0019, ADR-0022/0023, ADR-0026, ADR-0027, ADR-0028.
Amends: ADR-0026, ADR-0027 and ADR-0028 — see *Consequence for the invariant* below.

> **Gate — passed.** This ADR removes a human gesture, so it could not take effect until a human
> applied `docs/pending/human-presence-boundary-goal-ui-delegation.md` to the rule file. **A human
> did, out of band, on 2026-09-21.** Claude's own edit was refused by the settings deny list and
> Claude did not route around it; the receipt
> `docs/benchmarks/2026-09-21-goal-ui-delegation-boundary-patch-applied.md` records the provenance
> and the after-the-fact verification. This is the gate ADR-0028 set for the Goal Lease, for the
> same reason: the code that honours an authority must not precede the rule that says who may grant
> it.
>
> **It is still off by default.** With no `goalUiDelegationId` named, every delegation row is inert,
> the entire v5 surface is absent — no server, no discovery file, no sweeper — and ADR-0026 holds in
> full. Naming an id is the second human act, and it grants nothing on its own.

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

**v5's reachable tool surface is identical to v4's — not narrower.** The verb list is shorter; that
is not the same thing, and an earlier draft of this paragraph reasoned from the first to the second.

What is genuinely narrower is the *delegated* path. There is no `tool.call`: the browser stages a
candidate, which is inert, and later asks for it by reference — so the tool that runs is the one in
the stored row, and `run.dispatch` has no tool, no arguments and no way to change what was staged.

`run.human` is the other half, and it restores v4's shape: the browser names a tool and its
arguments in `run.stage`, then asks for them to run, with no delegation consulted, no budget spent
and — deliberately, per `human-presence-boundary.md` — no kill switch applied. That is exactly what
a v4 `tool.call` is, split across two frames. A review caught this ADR still claiming "narrower"
after that verb was added, in a paragraph that then concluded no stronger-isolation decision was
needed under ADR-0019. The premise was false; the conclusion needs a different argument.

**The argument that does hold** is that v5 adds no *consequential* authority. Every tool reachable
from either path is the proposal-only profile — `mutation.preview`, `file.create` and `git.commit`
create records a human must approve, and nothing on this surface approves anything. So v5 is
v4-equivalent in what it can cause, under a distinct identity, plus one new transition: Run, bounded
by a delegation a human issued and named. ADR-0019's bar is consequential browser authority, and
that is unchanged. The separate identity is not a reduction in authority — it is what stops a v4
session using a v5 delegation, and the reverse.

```text
hello · session.bind · session.unbind · ping · verbs.list
run.stage · run.dispatch · run.human · run.result
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

## Consequence for the invariant

ADR-0026 fixed one invariant covering both gestures, and ADR-0028 amended it for Approve only:

```text
ADR-0026   RUN_AND_APPROVAL = HUMAN
ADR-0027   RUN_AND_APPROVAL = HUMAN_ON_THE_PRODUCTION_PATH
ADR-0028   RUN_AND_APPROVAL = HUMAN_UNLESS_A_LEASE_ADMITS_THE_ACTION
```

All three are now wrong as written, and for a reason ADR-0028 already named about itself: a reader
following AGENTS.md's reading order meets the earlier text first, and a carve-out recorded only at
the benchmark layer leaves the ADR-layer invariant reading as absolute. ADR-0028's line is wrong in
a second and worse way — it reads as though a lease relaxes Run, which it never did and still does
not.

**The two gestures are two invariants, not one.** That is the substantive amendment:

```text
LOCAL_OPERATOR_APPROVAL = REQUIRED_FOR_EVERY_EFFECT_NOT_ADMITTED_BY_AN_ACTIVE_GOAL_LEASE
APPROVAL                = HUMAN_UNLESS_A_VALID_LEASE_ADMITS_THE_ACTION
RUN                     = HUMAN_UNLESS_A_VALID_UI_DELEGATION_ADMITS_THE_PROPOSAL
GOAL_LEASE_SCOPE        = APPROVE_ONLY_NEVER_RUN
UI_DELEGATION_SCOPE     = RUN_ONLY_NEVER_APPROVE
GOAL_LEASE_ADMISSION    = DETERMINISTIC_LOCAL_POLICY_OVER_DURABLE_RECORDS
UI_DELEGATION_ADMISSION = DETERMINISTIC_LOCAL_POLICY_OVER_DURABLE_RECORDS
ZERO_GESTURE_EFFECT     = REQUIRES_BOTH_GRANTS_NAMING_ONE_GOAL
NOTHING_CONFIGURED      = ADR_0026_UNCHANGED_IN_FULL
LEASE_ISSUANCE          = HUMAN_ONLY_AND_OUT_OF_BAND
UI_DELEGATION_ISSUANCE  = HUMAN_ONLY_AND_OUT_OF_BAND
PAGE_AND_MODEL          = NEVER_AUTHORITY
```

Read as prose, and this is the whole normative model:

- **Run** is a human gesture, unless a valid, configured Goal UI Delegation admits *that proposal*.
- **Approve** is a human gesture, unless a valid, configured Goal Lease admits *that action*.
- A delegation never approves anything. A lease never runs anything. Neither implies the other.
- With neither configured — every installation until someone deliberately changes that — ADR-0026
  holds in full, and that is asserted by tests rather than by this paragraph.
- The page is never authority and the model is never authority. Neither may create, widen, renew,
  select or substitute either grant. `.claude/rules/human-presence-boundary.md` carries the same
  three lines, applied to Claude specifically.

`GOAL_LEASE_SCOPE = APPROVE_ONLY_NEVER_RUN` is new here and is a clarification rather than a
change: no lease ever lifted Run, and nothing in ADR-0028's implementation did. Stating it stops
the symmetry from being inferred in the wrong direction by a later reader — the direction that
would produce an auto-clicking extension.

## Composing a delegation with a lease

Both grants live, both bounded, both issued by a human out of band: that composition is the only
path in WAG from an untrusted page's text to a durable effect **with no human gesture at any
step**. It is supposed to be reachable. What must not be reachable is reaching it by accident.

### What was wrong

Measured before this section was written: the lease checked `admittedSessions` and
`admittedAdapters`; the delegation checked `sessionId` and `adapterId`. Nothing compared the two
grants to each other. So a lease issued on Tuesday to let a benchmark rewrite `docs/**` would
silently admit effects that a delegation issued on Wednesday for something else entirely had
proposed — two humans, two bounded grants, and an authority neither of them had described.

That is composition by **union of coincidence**, and it is exactly the failure mode ADR-0019 is
about: authority acquired by nobody's decision.

### What it is now

```text
GoalLeaseBindings.delegatedGoalIds   goals whose DELEGATED work this lease will admit. Absent
                                     means none, which is every lease that existed before this.
LeaseRequest.delegatedGoalId         the goal of the live configured delegation bound to this
                                     session and adapter, re-read from durable rows at the
                                     consequence — never from a message, a proposal or an argument.
```

`evaluateGoalLease` refuses an action reaching it from a delegated adapter unless the lease names
a goal **and** that goal is the one a live delegation put in force for that browser context:

```text
adapter is not delegated     ADR-0028 unchanged, in full. No new check applies.
lease names no goal          DELEGATED_GOAL_NOT_ADMITTED — the effect needs the operator.
goal not resolvable          DELEGATED_GOAL_UNKNOWN — unknown provenance is not admitted.
goal not in the lease list   DELEGATED_GOAL_NOT_ADMITTED.
both name one goal           admitted, and every other bound of both grants still applies.
```

The composition is therefore an **intersection of two deliberate statements**: the delegation says
which goal may Run; the lease says which goal's delegated work it will Approve. Every other
dimension — session, adapter, workspace, tool, origin, path, byte and file budgets, commit
semantics, both validity windows, both kill-switch checks — is a conjunction, so the composed
authority is the intersection of the two grants and never their union.

Two consequences worth stating rather than leaving to be inferred:

- **This is a narrowing, not a new grant.** A lease written before this section keeps exactly the
  authority it had. What it loses is an authority nobody wrote down.
- **The composed window is the shorter of the two.** A delegation's ceiling is four hours and a
  lease's is twelve, so the zero-gesture path can never outlive four hours of delegation without a
  fresh human act. A test asserts that ordering, because if it ever inverts the window grows
  silently.

### The over-refusal, named

WAG cannot tell, at the *effect*, whether a v5 proposal reached it by `run.dispatch` or by
`run.human`: the mutation record carries a session and an adapter, not a proposal id, so the
`run_authority` row is not reachable from it. Rather than guess, the gate applies to the delegated
**adapter** — so a human-Run proposal on a v5 session also needs the lease to name the goal.

That is stricter than necessary and deliberately so. The alternative is a heuristic on the one path
that ends with no human gesture at all, and this project has already paid once for a bound that was
arithmetically correct and semantically wrong.

## Replay, and where its bound actually lives

The extension suppresses a re-observed provider message from `chrome.storage.session`. That memory
is ephemeral by construction — cleared by an extension reload, evicted past 256 entries, and read
as empty when the read itself fails, deliberately, because suppressing work that never ran is the
worse error.

Every one of those re-offers the same message, which stages a **new proposal id** carrying the
**same WAG-computed fingerprint**. Before this, that claimed a second slot and ran a second effect,
with `maxActions` holding arithmetically the whole time.

So the bound is in `claimDelegatedDispatch`, inside the transaction that spends the slot, over a
row the browser cannot write: two claims under one delegation may not share a fingerprint
(`PROPOSAL_REPLAY`). The extension's memory is demoted to an optimisation that saves a round trip.

```text
REPLAY_BOUND          = DURABLE_AND_INSIDE_THE_CLAIM_TRANSACTION
MAX_ACTIONS_SEMANTICS = DISTINCT_ACTIONS_NOT_DISPATCHES
```

The second line is a real change and is stated as one: a genuine repeat of an identical call now
needs a new delegation, which is a human act. An abandoned claim never releases its slot, so a
re-observation after a crash is refused rather than resurrected.

Across an extension **reload** the session id changes, so the delegation binds a context that no
longer exists and everything is refused with `SESSION_MISMATCH` before any claim — nothing spent,
nothing run. Both cases rest on durable WAG state; neither rests on the extension remembering.

## What this does not do

It grants no consequential tool by itself: a delegation carrying `mutation.preview` or
`git.commit` is a separate decision, and the effect still needs approval or a lease.

It does not edit the PreToolUse guard, the computer-use read tier or the settings deny list —
`.claude/` is untouched. But the honest framing, which an earlier draft of this ADR got wrong, is
**not** "this never touches the UI so the guard is irrelevant". The guard exists to stop Claude
*causing* a Run; clicking was merely the only mechanism it could see. This builds a mechanism it
cannot see. That is legitimate only because the authority comes from a human out of band and is
inert unless a human names it — which is why the rule patch was a gate on this ADR rather than a
footnote to it, and why applying it was left to a human whose own tooling refused to let Claude do
it.

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

## What activation takes, and what is now wired

An earlier draft of this section said activation was "two human steps and no code change: apply the
rule patch, then name a `goalUiDelegationId`". That was false, and the same paragraph said so two
sentences earlier — a review caught the contradiction. At the time, doing those two things changed
nothing observable, because the runtime wiring did not exist.

**The two human steps are still necessary and are still the gate.** They are now also sufficient,
because the six missing pieces are built. Each is named here with what it does, because "wired" is
the kind of claim that was wrong once already:

```text
src/browser-operator-runtime.ts     constructs the plane, the router and the coordinator, once per
                                    admitted connection, and only when a delegation is configured
src/delegation-dispatch-http.ts     a parallel loopback server with its own v5 registry, so a v5
                                    bearer cannot reach /mcp and a v4 bearer cannot reach dispatch
src/browser-adapter/native-host-v5  a second native host binary — not a mode flag on the v4 one,
  + local-link-v5                   because the two admit into different adapter identities
browser/extension/                  the shipped worker loads the v5 core, tries the delegated path
  native-session-core-v5.js         first, and falls through to the human queue on any refusal
src/delegation-claim-sweeper.ts     retires CLAIMED rows a crash stranded; never refunds the slot
protocol-v5 `run.human`             v5 *can* record a human Run. Parity with v4, not a widening —
                                    but the shipped panel does not use it yet; see the residuals
```

Two more that were not on the original list and turned out to be needed:

```text
src/delegated-run-executor.ts       runs the staged candidate AFTER the durable transition, from
                                    the stored row, server-side — the browser never gets a second
                                    call that could diverge from what it staged
src/delegated-tool-execution.ts     runs it through the same MCP server a clicked Run reaches, so
                                    the two paths cannot drift: it is the same function
scripts/delegation-control.ts       the out-of-band issuance path, for a human to run
```

### The bootstrap order, which is not obvious

A delegation binds a `sessionId`, and WAG mints that when the extension connects. So the session
exists before the delegation can be issued, and the delegation must be named in configuration
before it does anything:

1. name a placeholder id and start WAG. The v5 surface is up and authorises nothing — a placeholder
   names no row, so every delegated dispatch is refused `DELEGATION_NOT_FOUND`;
2. connect the extension. WAG mints the v5 session;
3. `delegation-control --sessions` to find it, `--issue` to bind a delegation to it;
4. name the printed id in `goalUiDelegationId` and restart WAG.

The reconnect in step 4 returns the **same** session id, because a session is keyed by the
correlation the extension holds in `chrome.storage.session`, which survives a WAG restart. That is
asserted rather than assumed — it is the one step a design document cannot establish, and if it
were false a delegation would stop matching the moment it was configured.

An extension *reload* does not survive: it re-mints the correlation, so the delegation stops
matching and must be reissued. That is the binding working, not a defect.

## Two defects the production wiring exposed

Both were in this design, both survived three adversarial reviews, and both were found by building
the thing rather than by reading it again.

### The session id was never the value the browser sends

The extension mints a **correlation** and sends it as `sessionId`. WAG hashes the correlation,
resolves a durable `adapter_sessions` row, and that row's id is a *different* `session_<uuid>`.
Same shape, never the same value — and the router compared them.

Every test used one value for both, so the comparison held trivially. In production `session.bind`
itself would have been refused and delegated Run would never have worked once. A fully green suite
would have shipped a surface that could not bind.

`session.bind` is now the one verb whose `sessionId` is not compared — identity there comes from the
bearer the gateway admitted, not from the envelope, and by the time the router runs, admission has
already happened. The bind answer carries the authoritative id, every later verb is compared against
it, and the native host records it from WAG's answer rather than assuming the correlation is it.
`test/delegated-dispatch-production-transport.test.ts` asserts the two are different strings, so a
regression that conflates them fails rather than passing vacuously.

### A delegation's workspace binding constrained nothing for some tools

A delegation binds one `workspaceId`, and that binding only means something because the tool
resolves its workspace from `arguments.workspace_id` and the two must agree. A tool with no such
argument has nothing to compare — `health`, and far more seriously `workspace.open`, which takes a
`path`.

So a delegation naming `workspace.open` in `allowedTools` let the browser open **any** path the
config's `allowedRoots` permitted, while the audit row recorded it as acting in the bound workspace.
The delegation read narrow and behaved wide.

On the delegated path, a tool that resolves no workspace can no longer be staged. The human path
keeps the old behaviour, because there are no bindings there to satisfy and a person opening a
workspace is the gesture the whole design defers to.

## What a crash costs, stated plainly

`CLAIM` spends the slot, before anything runs. Nothing refunds it — ever — because a refund would
make a crash a way to exceed `maxActions`.

```text
crash between CLAIM and DISPATCH    row stranded CLAIMED; the sweeper retires it to ABANDONED
                                    slot spent, no Run recorded, proposal never runs
crash between DISPATCH and result   row stays DISPATCHED with no result; audit says DELEGATED_RUN
                                    because it may have happened. Never re-run: single-assignment
                                    state means DISPATCHED can never return to STAGED
tool throws or errors               identical to the above. The slot was spent at CLAIM
```

The sweeper never touches a `DISPATCHED` row. That row reached a tool; abandoning it would claim
knowledge nobody has.

## Residual limits

- **Issuance is a rule, not a mechanism.** `scripts/delegation-control.ts` is a script, and code
  cannot tell whose hands are on the keyboard. What *is* enforced is narrower: nothing on the
  browser path can reach the control plane or the store methods behind it, because the dispatch
  plane is handed a port object that lacks them at runtime. ADR-0019 already places a same-user
  adversary outside the containment claim.
- **`npm run lease:stop` halts delegated Run as well as lease admission**, because ADR-0029 reuses
  the same kill-switch file rather than adding a second one nobody would remember in an emergency.
  Verified: both read `LOCALAPPDATA\WebAgentGateway`.
- **The human gate still lives in the browser.** The gateway cannot distinguish a clicked Run from
  an unclicked one on v4 or on v5. `run.human` is *a* way for a panel to report a click; it is not
  what makes a Run human. That was true before this revision and is unchanged by it.
- **`run.human` is not on the shipped human path.** A review found `runAsHuman` has no caller in
  `browser/extension/`: when the delegated path declines a candidate, the worker falls through to a
  v4 `tool.call` and the panel executes it over the v4 port, exactly as before. No `HUMAN_RUN` row
  is written in production today. The verb, the store transition and the `PROPOSAL_IS_DELEGATED`
  refusal are real and tested — what is missing is the panel using them. Left that way deliberately:
  rewiring the accepted human path buys no authority and risks the route everything else falls back
  to. Until it is done, "v5 is no longer delegated-only" is true of the protocol and not the product.
- **A tool whose arguments name no workspace cannot be delegated at all**, including `health`. That
  is deliberate and it is a real narrowing: such tools stay on the human path.

## Evidence

- `docs/benchmarks/2026-09-21-goal-ui-delegation-design-gate.md` — the design gate, three
  adversarial reviews and their disposition, the transport, the fixture-lane proof.
- `docs/benchmarks/2026-09-21-goal-ui-delegation-boundary-patch-applied.md` — the human-applied
  authority change, verified after the fact, and the two digests over the patch document.
- `test/delegated-run-production-runtime.test.ts` — a live `DELEGATED_RUN` through the shipped
  runtime, real MCP tool surface, real native host, zero manual Run clicks.
- `test/delegated-run-recovery.test.ts` — the sweeper, execution failure, restart after CLAIMED and
  after DISPATCHED, and the guards that no ordinary path reaches.
