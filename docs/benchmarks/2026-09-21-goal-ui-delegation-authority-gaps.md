# Closing the authority gaps before asking for a production grant

2026-09-21. Branch `feat/goal-ui-delegation-v1`. Nothing pushed. No production grant requested.

The previous handoff listed six residual gaps and asked a human to register a native host and issue
two grants. That request was withdrawn and this work done first, treating the handoff as a
**pre-production security gate** rather than `WAG_DC_REPLACEMENT=PASS`. Four gaps are closed here;
one is prepared and waiting on a human; the rest are restated with what they actually cost.

---

## 1. Replay — the HIGH finding, and why the previous answer was not one

### What was actually true

`delegated-observation-idempotence.test.ts` proved the extension does not re-run a candidate it
already decided. It proved exactly that and no more, because the memory it tests lives in
`chrome.storage.session`. The module says so in its own header. So the bound was exactly as durable
as `chrome.storage.session` — which is to say, not:

```text
an extension reload        clears it
past 256 entries           evicts in first-seen order, so a long conversation forgets its start
a failed read              reads as an empty memory, deliberately, because the alternative is
                           suppressing work that never ran
```

Each of those re-offers the same provider message. That staged a **new proposal id** carrying the
**same WAG-computed fingerprint**, claimed a second budget slot, and executed a second effect.
`maxActions` held arithmetically throughout, which is precisely why nothing on the store's side
looked wrong. The bound that failed was "one candidate runs once".

### Where the bound is now

`src/durable-store.ts`, inside `claimDelegatedDispatch` — the transaction that spends the slot,
over a row the browser cannot write:

```text
two claims under one delegation may not share a fingerprint    → PROPOSAL_REPLAY
```

The fingerprint is WAG's own derivation over tool, workspace, origin, session, adapter and
arguments. `stageProposal` repeats the check as a fail-fast so a rescan does not write a row per
proposal per rescan, but the fail-fast is a cost saving and **the transaction is the guarantee** —
asserted by a test that stages two proposals before dispatching either, which is the window the
fail-fast cannot see.

### The semantic change, stated rather than buried

```text
MAX_ACTIONS_SEMANTICS = DISTINCT_ACTIONS_NOT_DISPATCHES
```

A genuine repeat of an identical call now needs a new delegation, which is a human act. Three
existing tests failed on this and were **corrected rather than accommodated**: they staged the same
arguments repeatedly to count budget, which is one action re-observed rather than three actions. A
fourth test was added to pin the new semantic directly.

An abandoned claim never releases its slot, so a re-observation after a crash is refused rather
than resurrected.

### The exact case the instruction named

`test/delegated-run-replay-durability.test.ts`, 11 tests, driving the **production transport** — a
real native host over real streams with real length-prefixed framing, and the shipped extension
modules, not stand-ins.

| Boundary destroyed | Result |
| --- | --- |
| memory lost, session intact | `PROPOSAL_REPLAY` at stage. 1 effect, 1 claim. |
| two proposals staged, then both dispatched | first admitted, second `PROPOSAL_REPLAY`. Refused before the claim, so the row stays `STAGED`. |
| both dispatched concurrently | exactly one `ok`, one `PROPOSAL_REPLAY`, one effect, one slot. |
| **extension reload** — port dies, new host, new correlation, new durable session | `SESSION_MISMATCH`. No second effect, no second slot. |
| reloaded extension tries the *previous* session's proposal | `SESSION_MISMATCH`, row stays `STAGED`. |
| **whole extension core recreated**, empty memory, same message | it re-offers — and WAG answers `PROPOSAL_REPLAY`. |
| storage that **throws on every read** | same. The module's "unreadable memory re-offers" behaviour is safe precisely because it is no longer load-bearing. |
| memory intact | `alreadyDecided`, no round trip. The optimisation still works. |
| abandoned claim, then re-observed | `PROPOSAL_REPLAY`. Abandonment never refunds. |
| genuinely different arguments | runs. 2 effects, 2 claims. The half that must not regress. |
| a hostile extension varying arguments | bounded by `maxActions`, and that is the honest claim — replay protection keys on the action's identity and does not pretend to bound an extension that is lying. |

**Both surviving mechanisms rest on durable WAG state.** Neither rests on the extension
remembering anything.

---

## 2. Composition — a defect found by asking, not by testing

### What was wrong

ADR-0028 lifts Approve. ADR-0029 lifts Run. Each was reviewed alone; neither knew the other
existed. Composed, they are the only path from an untrusted page's text to a durable effect with
**no human gesture at any step** — which is the point of the two together, and fine.

What was not fine: before this, the lease checked `admittedSessions` and `admittedAdapters`, the
delegation checked `sessionId` and `adapterId`, and **nothing compared the two grants to each
other**. A lease issued on Tuesday to let a benchmark rewrite `docs/**` would silently admit
effects that a delegation issued on Wednesday for something else entirely had proposed. Two humans,
two bounded grants, an authority neither described. That is union by coincidence.

### What it is now — intersection

```text
GoalLeaseBindings.delegatedGoalIds   goals whose DELEGATED work this lease admits. Absent = none.
LeaseRequest.delegatedGoalId         from resolveDelegatedGoal(), re-read from durable rows at the
                                     consequence. Never from a message, proposal or argument.
```

| Case | Outcome |
| --- | --- |
| adapter is not delegated | ADR-0028 unchanged, in full |
| lease names no goal | `DELEGATED_GOAL_NOT_ADMITTED` — effect needs the operator |
| goal not resolvable | `DELEGATED_GOAL_UNKNOWN` — unknown provenance is not admitted |
| goal not in the lease's list | `DELEGATED_GOAL_NOT_ADMITTED` |
| both name one goal | admitted, with every other bound of both grants still applying |

Every other dimension — session, adapter, workspace, tool, origin, path, byte and file budgets,
commit semantics, both windows, both kill-switch checks — is a conjunction. So the composed
authority is the **intersection** of the two grants, and the goal linkage is what was missing for
*intent* rather than for scope.

**This is a narrowing.** A lease written before this keeps exactly the authority it had; what it
loses is an authority nobody wrote down. Every pre-existing lease test still passes unchanged (53
of them), because they use non-delegated adapters and the gate is inert there.

`src/delegated-run-provenance.ts` is the only thing that answers "which goal is in force", and it
answers by re-reading one durable row: not revoked, not superseded, inside its window, inside the
4h ceiling, bindings parseable, and bound to **this** session and **this** adapter. Anything else
returns `undefined`, which on a delegated adapter denies.

### The over-refusal, named rather than hidden

WAG cannot tell at the *effect* whether a v5 proposal arrived by `run.dispatch` or `run.human`: a
mutation record carries a session and an adapter, not a proposal id, so the `run_authority` row is
not reachable from it. The gate therefore applies to the delegated **adapter**, so a human-Run
proposal on a v5 session also needs the lease to name the goal.

Stricter than necessary, deliberately. The alternative is a heuristic on the one path that ends
with no human gesture at all.

### The matrix

`test/goal-lease-delegation-composition.test.ts`, 28 tests: expiry, revocation, supersession,
restart, stale session, cross-workspace, cross-goal, action budgets, path budgets, file and byte
budgets, tool mismatch, adapter mismatch, kill switch, malformed bindings, guessed goal ids, and
the assertion that the delegation ceiling (4h) is shorter than the lease ceiling (12h) so the
composed window can never grow silently.

Three of those are worth naming because they are not obvious:

- **the two budgets are independent.** A lease refusal spends no delegation action, and an
  exhausted lease cannot borrow the delegation's remaining actions. They count different things
  from different tables and neither subsidises the other.
- **revoking the delegation closes the path for work already in flight**, not only for work not yet
  proposed. The provenance is resolved at the *consequence*, so a proposal sitting pending review
  becomes inadmissible the moment its delegation is revoked — and the lease is not touched, so the
  operator only has to revoke one of the two grants.
- **the stdio surface is inert by identity.** `repository-engineering-runtime.ts` passes no
  `uiDelegation`, and that is correct rather than an oversight: its caller context is
  `private.stdio.v1`, which no delegation can bind. Asserted rather than assumed.

---

## 3. The issuance guard — prepared, not applied

`.claude/rules/human-presence-boundary.md` says, twice, that issuance is human-only and that Claude
may use a grant but never create one. **Neither statement had a pattern behind it anywhere** — not
in the hook, not in the deny list. It was a rule kept by Claude choosing to keep it.

Leases are in the same position and were not singled out: there is no `lease:issue` script at all,
and `insertGoalLease` is reachable only from an ad-hoc script. The patch covers both.

```text
docs/pending/authority-issuance-guard.md            the patch, its rationale, its digests
docs/pending/apply-authority-issuance-guard.mjs     the fail-closed applier, --check / --apply
test/authority-issuance-guard.test.ts               13 executable regression tests
```

What it refuses: the control CLI with `--issue`/`--renew` under a runner; a one-liner calling
`insertUiDelegation(` / `renewUiDelegation(` / `insertGoalLease(` / `new UiDelegationControlPlane(`;
and a **JSON write naming `goalUiDelegationId` or `goalLeaseId`** — the quieter half, and the one
that matters, because a delegation not named in configuration is inert whatever its row says.

What it does not refuse: `--revoke`, `npm run lease:stop`, `--show` / `--sessions` / `--workspaces`,
every read, every ordinary gate, and writes to `src/` / `scripts/` / `test/` / `docs/`. A guard that
made revocation harder than issuance would have the sign wrong, and a text rule that refused source
files would refuse the analysis of this boundary — the same over-match that once refused a commit
message for quoting a filename.

`.claude/settings.json` is **unchanged**, and the patch says why: the deny list matches tool names
and path globs, and issuance is a command shape and a JSON field name. A change that cannot express
the rule is decorative, not minimal.

### The tests do not skip while it is pending

A suite that skipped until someone applied a patch would be the same defect in different clothes.
Instead the behaviour tests load the applier's own `REPLACEMENTS` table, apply it in memory, write
the result to a scratch file and **execute it**. They run identically before and after application
and cannot drift from what a human would install, because they are built from it.

One test asserts the live guard is in exactly one of two known states — committed or patched — with
no third outcome. Another asserts the *measured* gap: the live guard currently lets issuance
through, which is why the patch exists, and when it is applied that branch swaps for its converse.
Neither branch is a no-op.

A separate test proves the patch is **purely additive**: every replacement's `to` contains its
`from`, mechanically, so no existing refusal can have been dropped.

---

## 4. Normative reconciliation

ADR-0029 gained `Amends:` and three sections: *Consequence for the invariant*, *Composing a
delegation with a lease*, and *Replay, and where its bound actually lives*.

```text
ADR-0026   RUN_AND_APPROVAL = HUMAN                                    ← historical record
ADR-0027   RUN_AND_APPROVAL = HUMAN_ON_THE_PRODUCTION_PATH             ← historical record
ADR-0028   RUN_AND_APPROVAL = HUMAN_UNLESS_A_LEASE_ADMITS_THE_ACTION   ← historical record
```

ADR-0028's line was wrong in a way worth naming: it reads as though a lease relaxes Run, which it
never did. The model now separates the two gestures into two invariants and adds
`GOAL_LEASE_SCOPE = APPROVE_ONLY_NEVER_RUN` beside `UI_DELEGATION_SCOPE = RUN_ONLY_NEVER_APPROVE`,
so the symmetry cannot be inferred in the wrong direction by a later reader — the direction that
produces an auto-clicking extension.

ADR-0026, 0027 and 0028 each gained a one-line `Amended by:` pointer. **No historical text was
rewritten**: each says the text below is the record of what that decision decided, not a statement
of current policy. That is the failure mode ADR-0028 named about itself — a reader following
AGENTS.md's order meets the earlier text first.

`scripts/p1a-evidence.ts`: `humanRun: 0` used to mean one thing and now means two. Added optional
`delegatedRun` and `policyApproved` counters so a reader who was not present can tell a task that
needed no help from one that was helped by a grant. The gesture counts stay **required with no
default** — a default there hides a gesture — while the grant counts may default to zero, because
zero is the truth for every record written before these authorities existed. The asymmetry is the
point and is documented as such.

---

## 5. Mutation testing — 4 survivors, all repaired

25 new mutations. First run: **21 caught, 4 survived.** Every survivor was a real finding.

| Survivor | What it meant | Repair |
| --- | --- | --- |
| replay lookup scoped to the proposal | the `AND proposal_id != ?` clause was **dead** — the state check refuses anything not `STAGED`, and a claim always leaves the row `CLAIMED`, so this proposal can never already hold a claim | removed the clause. Dead code in the transaction the whole design rests on is worse than a redundant guard. |
| empty delegated-goal list reads as every goal | behaviourally equivalent, but the *ordering* was untested: a lease admitting no delegated goal should say so rather than blame an unresolvable provenance | added a test pinning the refusal code **and** its detail |
| superseded delegation still in force | untestable through the store: `renewUiDelegation` sets `superseded_by` **and** `revoked_at` in one transaction, so revocation always denied first and the supersession check was never reached | a hand-built port producing superseded-and-not-revoked, which only a direct write can make |
| unparseable bindings resolve to a goal | the mutation was too weak — its fabricated bindings had no session, so the session check denied anyway | sharpened the mutation to fabricate bindings that *would* match, which is the case that matters |

Second run: **25 caught, 0 survived, 0 redundant, 0 inconclusive.** Whole battery, 138 mutations:
**133 caught, 5 redundant-by-design, 0 survived, 0 inconclusive.**

### A sixth, found by re-reading my own comment rather than by a tool

`DELEGATED_RUN_ADAPTERS` is restated in `goal-lease.ts` to keep that module pure, and the comment
claimed the composition test "asserts this list against `adapter-admission.ts`, so a future
delegated adapter that is not added here fails loudly". **It did not.** The test compared the list
to a hardcoded literal, so adding a v6 delegated adapter would have passed while the composition
gate silently stopped applying to it. Confident prose over a mechanism nothing reached — the same
class of defect as all four prior reviews, written this time in the comment justifying the
countermeasure.

The test now enumerates every exported `*_ADAPTER_ID` and requires each to be classified as
delegated or explicitly not. Verified by injecting a fifth adapter identity and confirming the test
fails, then reverting it — `git diff src/adapter-admission.ts` is empty.

---

## Gates

| | |
| --- | --- |
| `npm test` | **808 tests, 802 pass, 0 fail, 6 pre-existing todo, exit 0** (1137 s) |
| typecheck / build | clean |
| `test:goal-lease` · `test:dc-replacement` · `test:business` · `test:delegation-e2e` | 2/2 · 1/1 · 1/1 · 15/15 |
| mutations | 138 total, **133 caught, 5 redundant-by-design, 0 survived, 0 inconclusive** |
| built v5 native host over real stdio | passes |
| boundary drift check | rule files ok, both patch digests ok, guard reported `pending` |
| `.claude/` touched by Claude | never — `git status --porcelain -- .claude/` empty throughout |

The suite was run twice: once before the adapter-drift repair above, and once from clean state
after it, because a source edit invalidates a run in progress. The composition mutations were
re-run after the test changed, and the battery restored to all 138 before the final suite.

`npm run test:operator-browser` was **not** re-run, and this says so rather than skipping it
quietly. Its subject — `operator-server.ts`, `http-server.ts`, `sidepanel.js` — is untouched by
this milestone, shown by diff, and it needs an owned Playwright worker that the resource policy
says not to allocate without need.

## What is still open, and what it costs

1. **The guard patch is not applied.** Claude cannot apply it; `.claude/settings.json` denies the
   write and Claude did not escalate to a shell. Until a human runs the applier, issuance has a
   rule and no pattern — the state the drift checker now reports explicitly as `pending`.
2. **The browser-level delegated Run has not happened.** Unchanged and deliberately not requested
   yet. The v5 host builds and is proved over real stdio; registration under the Edge HKCU key and
   the two issuance acts remain human acts, and this milestone does not ask for them.
3. **v5's human-Run verb is not on the shipped human path** — the panel still uses v4.
4. **A hostile extension is bounded by `maxActions`, not by replay protection.** Replay keys on the
   action's identity; an extension that varies arguments produces genuinely distinct actions. The
   budget is the bound, and the test says so rather than implying more.
5. **WAG still cannot verify that a human clicked.** `HUMAN_RUN` means "no delegation authorised
   this". True before ADR-0029 and true after.
6. **A shell is a same-user escape hatch** (ADR-0019). Every guard here is a tripwire.

`WAG_DC_REPLACEMENT` is **not** declared PASS. The browser-level proof is the gap and it is gated
on acts this milestone deliberately did not request.
