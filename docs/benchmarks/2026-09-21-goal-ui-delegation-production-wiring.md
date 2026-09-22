# Delegated Run, wired into production

2026-09-21. Branch `feat/goal-ui-delegation-v1`.

The design gate for ADR-0029 passed on evidence three weeks of review could produce without the
thing existing. This records what happened when it was built: two defects the design had, both of
which survived three adversarial reviews, and both of which were found by wiring it up rather than
by reading it again.

## What was missing, and is not any more

The previous receipt listed six unbuilt pieces, measured rather than estimated. All six are built,
plus three that were not on the list and turned out to be required.

| Piece | What it does |
| --- | --- |
| `src/browser-operator-runtime.ts` | constructs the plane, router and coordinator per admitted connection — and only when `goalUiDelegationId` is configured |
| `src/delegation-dispatch-http.ts` | a parallel loopback server with its own v5 registry |
| `src/browser-adapter/native-host-v5.ts` + `local-link-v5.ts` + `native-host-delegation-main.ts` | a second native host, built by `build:delegation-native-host` |
| `browser/extension/native-session-core-v5.js` + `service-worker.js` | the shipped worker tries the delegated path, and falls through to the human queue on any refusal |
| `src/delegation-claim-sweeper.ts` | retires `CLAIMED` rows a crash stranded |
| `protocol-v5` `run.human` | v5 *can* record a human Run — but the shipped panel does not use it; see review finding 4 |
| **`src/delegated-run-executor.ts`** | *not on the list* — something has to actually run the staged candidate |
| **`src/delegated-tool-execution.ts`** | *not on the list* — and it has to run it through the surface a clicked Run reaches |
| **`scripts/delegation-control.ts`** | *not on the list* — issuance had no path at all, in production, for leases either |

That last row deserves its own sentence. `insertGoalLease` has no production caller and never has:
only `src/harness-authority.ts` and tests. "Issued by a human, out of band" was realised as *there
is no path*, which is airtight and unusable. The delegation control CLI is the first time either
authority has had one.

## The two defects

Both were in the design. Both survived three adversarial reviews. Both were found by building it.

### 1 — the session id was never the value the browser sends

The extension mints a **correlation** and sends it as `sessionId`. WAG hashes the correlation,
resolves a durable `adapter_sessions` row, and that row's id is a *different* `session_<uuid>`
minted by `getOrCreateAdapterSession`. Same shape — both match `OPERATOR_CORRELATION_PATTERN` — and
never the same value.

The router compared them:

```ts
if (envelope.sessionId !== this.options.connection.sessionId) return SESSION_MISMATCH;
```

In production that refuses `session.bind` itself. Not intermittently, not under load — every time,
from the first frame. Delegated Run would never have worked once.

**Why no test caught it.** Every suite used one value for both sides:

```ts
const CONNECTION = { sessionId: SESSION, ... };
r.handle({ ..., sessionId: SESSION, ... });
```

so the comparison held trivially and the mutation "the envelope session is believed instead of
compared" was caught by a test that could not distinguish the two concepts. A fully green suite,
128 delegation tests, three reviews, and a surface that could not bind.

**Closed.** `session.bind` is now the one verb whose `sessionId` is not compared — identity there
comes from the bearer the gateway admitted, and by the time the router runs, admission has already
happened, so `connection` is fixed and the envelope contributes nothing. The bind answer carries the
authoritative id; every later verb is compared against it; and the native host records it from WAG's
answer rather than assuming the correlation is it, failing closed if the answer carries none.

The new suite asserts the two are different strings **in the fixture itself**, so a regression that
conflates them fails rather than passing vacuously:

```ts
assert.notEqual(sessionId, correlationId,
  'the durable session id must differ from the correlation, or this suite proves nothing');
```

### 2 — a delegation's workspace binding constrained nothing for some tools

A delegation binds one `workspaceId`. That binding only means anything because every WAG tool
resolves its workspace from `arguments.workspace_id`, and `validateStageableArguments` requires the
two to agree. Review 3 found and closed that.

What review 3 recorded as an observation — "`health` takes no `workspace_id`, so nothing
cross-checks the staged `workspaceId`" — is the same hole, and the conclusion drawn from it was too
weak. `health` is harmless. **`workspace.open` is not.** It takes a `path`.

So a delegation naming `workspace.open` in `allowedTools` let the browser open *any* path the
config's `allowedRoots` permitted, while the audit row recorded it as acting in the bound workspace.
The delegation read narrow and behaved wide. `allowedRoots` still bounded it — the containment did
not fail — but the delegation's own binding contributed nothing.

**Closed.** `requireWorkspaceBinding` is set exactly when a delegation is named:

```text
delegated path   a tool that resolves no workspace from its arguments cannot be staged
human path       unchanged — there are no bindings there to satisfy, and a person opening a
                 workspace is the gesture the whole design defers to
```

This is a real narrowing: `health` and `workspace.open` can no longer be delegated at all.

## The live proof

`test/delegated-run-production-runtime.test.ts`. Nothing below `startBrowserOperatorRuntime` is
stubbed — real config loader, real store, real v5 admission server, real native host over streams
with real length-prefixed framing, and the same `createBrowserOperatorAdmittedMcpServer` a clicked
Run reaches.

It walks the documented bootstrap rather than shortcutting it:

```text
1. name a placeholder id, start WAG        surface up, authorises nothing
2. connect the extension                   WAG mints the v5 session
3. open a workspace on the HUMAN path      run.stage + run.human -> HUMAN_RUN  (true of the
                                           test; the shipped panel still uses v4 — finding 4)
4. issue a delegation out of band          bound to that session and workspace
5. name it, restart WAG
6. reconnect with the same correlation     the SAME session comes back
7. stage + dispatch repo.search            DELEGATED_RUN, zero clicks
```

Step 6 is the one a design document cannot establish. If the session did not survive a restart, a
delegation would stop matching the moment it was configured, and the whole scheme would be unusable
in a way no unit test would show. It survives, because a session is keyed by the correlation the
extension holds in `chrome.storage.session`.

The result:

```text
authority   DELEGATED_RUN
goalId      goal_production_runtime
resultId    res_<32 hex>
result      repo.search found the needle in a real git-tracked file
row state   RESULTED, under the durable session id, in the bound workspace
claims      1 of 2
```

and in the same store, from step 3:

```text
authority   HUMAN_RUN
delegation  (none)
```

Two authorities, one table, distinguishable after the fact — which is what the audit requirement
asked for.

Also pinned there: with no `goalUiDelegationId`, the entire v5 surface is absent (no server, no
discovery file, no sweeper) and v4 is untouched; a configured placeholder naming no row is refused,
because naming is not granting; and revocation from a second connection lands on the very next call
with no restart.

## What a crash costs

`CLAIM` spends the slot, before anything runs. **Nothing refunds it, ever** — a refund would make a
crash a way to exceed `maxActions`.

| Crash point | Row ends at | Slot | Re-runnable |
| --- | --- | --- | --- |
| between CLAIM and DISPATCH | `ABANDONED`, by the sweeper | spent | no — and no Run was recorded |
| between DISPATCH and result | `DISPATCHED`, no result | spent | no — `DISPATCHED` can never return to `STAGED` |
| tool throws or errors | `DISPATCHED`, no result | spent | no |

The sweeper never touches a `DISPATCHED` row. That row reached a tool; abandoning it would claim
knowledge nobody has. `test/delegated-run-recovery.test.ts` covers all three, plus restart after
`CLAIMED` and after `DISPATCHED`, and that a restart does not reset the budget.

## Mutation testing

The battery said "0 survived" about code that did not exist. Twenty mutations were added across the
executor, the sweeper, the transport seam, the workspace binding, the native host and the loopback
server.

**Seven survived. One existing mutation no longer applied at all** — its anchor had moved when the
workspace-binding branch changed, so it was scoring as *caught* while mutating nothing, which is
worse than a survivor because it is invisible.

Each survivor was closed with a test, not by retargeting:

| Survivor | What was missing |
| --- | --- |
| a dispatch route accepts any bearer the registry knows | nothing exercised the coordinator-map check separately from the registry |
| the dispatch server answers requests carrying a browser Origin | no test sent an `Origin` header |
| the host answers a transport failure as a policy refusal | no test killed the server mid-session |
| the sweeper abandons dispatched rows too | the existing test used a `RESULTED` row, which the mutation does not touch |
| the executor runs a row that never reached DISPATCHED | unreachable through the router |
| the executor does not re-validate the stored arguments | unreachable through the router |
| the executor runs whatever the router answered | *caught after the first fix; listed for completeness* |

The last two are the recurring defect class in its purest form: guards written confidently and
reached by no test. They are now reached by handing the **executor** a port that returns a row the
store never would, while the router keeps the real one — so the decision and the durable transition
stay genuine and only the post-transition read is tampered with. That models a same-user edit to the
SQLite file, which ADR-0019 places outside the containment claim but which these guards cost nothing
to keep.

One mutation was retargeted rather than tested, and it is named here because retargeting is how a
battery gets quietly weakened: the router's own `SESSION_MISMATCH` is unreachable through the
production path, because the native host records the authoritative id from the bind answer and
refuses anything else a layer earlier. Both layers have their own mutation; only the suite each
runs against changed.

```text
102 mutations, 96 caught, 6 redundant-by-design, 0 survived, 0 inconclusive, exit 0
```

## The fourth review, of the production wiring — eight findings, all closed

The wiring was reviewed independently once built. The core properties held and are recorded below
as negative results, because a review that only lists what broke is half a review. Eight findings
came with them, and the two worst were things the design had been *claiming* since the gate.

### 1 — the delegated path had no idempotence, so one message ran N times (HIGH)

`queueProviderRequest` dedupes by `proposalIdentity(session, tab, messageId, tool, args)`, and its
header says exactly why: *"a rescan, a page reload, a worker restart, an extension reload and a
side-panel reopen all re-observe the same assistant message… which is why the live dogfood filled
the panel with duplicates."*

The delegated path ran **before** that call and was handed no `messageId`. So:

```text
1. a turn contains an in-scope proposal. Delegated, executed, slot 1 spent.
2. the user opens the side panel -> attachAndRescan -> provider.rescan
3. the content script clears its own suppression map by design and re-emits every completed turn
4. each one stages, claims, dispatches and EXECUTES again. Another slot each.
```

Ten in-scope proposals in a conversation drained a `maxActions: 20` delegation in two panel opens.
`chrome.runtime.onInstalled` and `onStartup` do the same thing.

`maxActions` held arithmetically the entire time — every run really did spend a slot — which is why
nothing on the store side looked wrong. The bound that failed was the one `human-presence-boundary.md`
asserts: *"reattachment and rescan are the extension's own job and are idempotent by proposal
identity."* True of v4. False of the path built on top of it.

**Closed** by `browser/extension/delegated-observation-v5.js`, which shares the v4 queue's own
`proposalIdentity` — sharing it is the point, or the two paths would disagree about what one
proposal is. An identity is remembered once the delegated path reached a *decision*; a candidate
that was never attempted (no host, no delegation, no workspace) is deliberately not remembered, so
enabling delegation tomorrow still picks up work skipped today.

The logic was extracted out of `service-worker.js` specifically so it could be **executed** by a
test. The existing extension tests read the worker as source text, and a missing call is precisely
the thing that looks like the code around it. Ten tests, and mutation coverage where there was none:
`scripts/delegation-mutations.json` had zero entries for anything under `browser/extension/`, so
"102 mutations, 0 survived" had said nothing whatever about this path.

### 2 — "the two human steps are now sufficient" was false: nothing built the v5 host (HIGH)

The extension connects to `com.openai.web_agent_gateway_v5`. That name appeared in exactly two
places in the tree — that line, and a comment. No manifest generator, no build entry, no installer.
`build-native-host.ts` has a single entry point and it is the v4 host;
`native-host-delegation-main.ts` was compiled by `tsc` and shipped nowhere.

Consequence on a real machine after doing both human steps: `connectNative` fails, `tryDelegatedRun`
gives up, every proposal falls through to the human queue. Fail-closed, so not a hole — but the
ADR's headline claim was wrong, and it was wrong *in the section written to announce that the
absent-mechanism defect class was gone*.

Why the suite did not catch it: every proof drives `runNativeDelegationHost` directly over
`PassThrough` streams. The receipt's phrase "nothing below `startBrowserOperatorRuntime` is stubbed"
was true and misleading — the missing layer was *above* it.

**Closed** by `scripts/build-delegation-native-host.ts` (a parallel script, so it cannot alter the
signed v4 artifact's bytes), `src/browser-adapter/native-host-manifest-v5.ts`, and
`npm run build:delegation-native-host`. The binary was built and then *verified by running it*:

```text
$ npx tsx scripts/verify-delegation-native-host.ts
ok    hello
ok    bind returns the authoritative session id  session_131e868f-…
ok    bind returns it as a different string from the correlation
ok    bind offers the configured delegation
ok    stage
ok    dispatch is admitted as DELEGATED_RUN
ok    the tool ran exactly once
ok    a replay is refused
ok    and nothing ran twice
ok    the durable row is RESULTED
ok    the audit row says DELEGATED_RUN
ok    exactly one slot was spent

the built v5 native host speaks the protocol over real stdio.
```

That spawns `wag-native-host-v5.exe` with the extension origin, exactly as Chrome would, and drives
a full delegated Run through its stdin and stdout. It is a script rather than a test because it
needs a 94 MB artifact `npm test` must not require.

**Registering** the manifest is still a separate human act, and the browser-level run still needs
the two issuance steps. What changed is that it is now possible at all.

### 3 — the coordinator map leaked, and hitting its cap killed a live session (MEDIUM-HIGH)

Keying coordinators by bearer is right: a reconnect must start unbound, and only a new bearer
guarantees that. The header argued that carefully and then did not handle the lifecycle it creates.

`admission.admit()` invalidates the session's *previous* token as a side effect, so the old bearer
401s — but nothing removed its coordinator. Every reconnect that did not cleanly unbind (an MV3
worker killed without warning, a browser crash, a best-effort release that did not land) leaked one
entry, and `MAX_LIVE_COORDINATORS = 64` counted the corpses.

Worse, the capacity check ran **after** `admit()`. At the cap, the next admission still invalidated
the working session's bearer, then returned 503 and registered nothing — so a reconnect at the cap
killed the session it was trying to restore.

And `McpDelegatedToolExecutionPort` leaked with no cap at all: each holds a connected MCP client,
server and linked transport pair for the process lifetime, and `handleRelease` dropped the
coordinator without closing what it held. Two ChatGPT tabs are enough to drive it — the controller
holds one bound session, so every tab switch unbinds and rebinds.

**Closed**: the capacity check moved before `admit`; a `liveBearerBySession` map evicts the
predecessor; `DelegatedRunCoordinator` gained a `dispose` the runtime supplies, so releasing a
connection closes its MCP pair; and `close()` disposes everything still open. Three tests, one of
which performs 70 reconnects and asserts none of them fails.

Worth naming separately because `.claude/rules/resource-policy.md` opens with "this Windows machine
runs out of CPU and RAM before it runs out of work".

### 4 — `run.human` is not on the shipped human path (MEDIUM)

`runAsHuman` has no caller in `browser/extension/`. When the delegated path declines a candidate,
the worker builds a **v4 `tool.call`** and the panel executes it over the v4 port, as before. No
`HUMAN_RUN` row is written in production.

So several claims overstated it: "v5 is no longer delegated-only", "`run.human` is how the panel
reports a click", and the protocol header's "the gap is not closed" framing. The mechanism is real
and tested; the panel does not use it.

**Closed as a documentation fix, deliberately.** Rewiring the accepted human path buys no authority
and risks the route everything else falls back to. The ADR now says plainly that this is true of the
protocol and not of the product, and the receipt's bootstrap table says "true of the test, not the
product" where it describes step 3.

### 5 — the ADR-0019 argument rested on a premise `run.human` invalidated (MEDIUM)

The ADR said *"v5 is narrower than v4, not wider… which is why this revision needs no
stronger-isolation decision under ADR-0019"*. With `run.human`, a v5 session names a tool and its
arguments and the gateway runs it, with no delegation consulted, no budget spent and no kill switch
applied. That is a `tool.call` split across two frames. v5's reachable tool surface is **identical**
to v4's, not narrower.

This is the third time this ADR has argued from a verb count to an authority claim, and the second
time a review has had to point it out.

**Closed** with a different argument, which is the one that actually holds: v5 adds no
*consequential* authority. Every reachable tool is the proposal-only profile — `mutation.preview`,
`file.create` and `git.commit` create records a human must approve, and nothing on this surface
approves anything. ADR-0019's bar is consequential browser authority, and that is unchanged. The
separate identity is not a reduction; it is what stops a v4 session using a v5 delegation.

### 6 — a lost dispatch response both delegated and queued, so work could run twice (MEDIUM)

`run.dispatch` reaches WAG, the claim and the transition commit, the tool runs, `DELEGATED_RUN` is
written — and *then* the port dies. `handleDisconnect` rejects every pending promise, the worker's
`catch` returned `undefined`, and the same candidate was queued for a person to Run again.

For `repo.search` that is harmless. For `mutation.preview` or `file.create` it produces two review
records for one page message.

**Closed**: `stageAndDispatch` now distinguishes the two transport failures by phase. A failure
*before* the dispatch is sent is `STAGE_TRANSPORT_FAILED` — staging is inert, nothing was spent, and
the candidate may be offered to a person. A failure *after* is `DISPATCH_INDETERMINATE`, which is
remembered and never queued, because the honest answer is "unknown" and the two call for opposite
responses. The proposal is visible in WAG's durable state as a `DISPATCHED` row, which is where an
operator should look.

### 7 — stale prose left by this pass (LOW-MEDIUM)

- `abandonExpiredClaims`' comment still said **"not yet wired"** after the sweeper was built. That
  comment exists because a review once caught it asserting the opposite falsely; the correction then
  rotted the other way. Both versions are now recorded in it, because the lesson is that a comment
  describing *callers* rots whenever callers change.
- `delegated-dispatch-e2e.acceptance.ts` still said "the rule patch is unapplied". It was applied the
  same day.
- "The host relays whole envelopes and **decides nothing**" — it decides five things: duplicate
  request ids, a 4096-frame budget, `hello`, `SESSION_ALREADY_BOUND`, and the authoritative-session
  comparison. All refusals, so the direction is right, but the module's own wording ("interprets
  almost nothing") was accurate where the ADR and commit message were not.
- The host's `seen` set clears only on `session.unbind`, so a long-lived tab hard-stops at 4096 v5
  frames with `TOO_MANY_REQUESTS`. Fail-closed, availability only, and now recorded.

### 8 — issuance has a rule and no tripwire (LOW, open by design)

`.claude/hooks/wag-human-gate-guard.mjs` has no pattern matching `delegation-control`, `--issue` or
`goalUiDelegationId`, and `.claude/settings.json` denies neither. The operator's *credential* and its
*approve/reject routes* each got a hook pattern and a deny rule; delegation issuance — the thing that
removes the Run gesture — got neither.

Verified, and worth stating precisely: the guard has no **lease** patterns either. So this is not
delegation being singled out; it is that neither authority's issuance had a production path until
`scripts/delegation-control.ts`, and a tripwire for a path that did not exist would have matched
nothing. It exists now, which is what makes the gap newly real.

**Open, and it must be.** Claude cannot add it: writes under `.claude/` are denied, and routing
around that denial is the one thing this whole milestone is built to demonstrate Claude will not do.
The exact addition is in the handoff, for a human. It is a request to *tighten* a control, which is
legitimate to propose and not to apply.

### Negative results

A review that only lists what broke is half a review. These were checked and found sound:

```text
a v5 bearer cannot reach /mcp — structurally      two registries, disjoint token maps, 404 elsewhere
the executor adds no policy                       every branch ends in failed(); refusals verbatim
the executor's tool name comes only from the row  nothing else constructs one
no goalUiDelegationId -> the v5 surface is absent  everything is inside one conditional
npm run lease:stop halts delegated Run            same directory, read live, fails engaged
the session.bind exemption                        identity is the bearer's; a second bind changes nothing
the coordinator's synthesized run.result          passes its own ownership check; nothing to abuse
a crash never refunds a slot                      claim rows are never deleted
maxActions across reconnect and restart           durable rows; session survives by correlation
issuance unreachable from browser/native/runtime  the port is a frozen allowlist, built by enumeration
one store, two surfaces                           workspaces gated on adapterId; registries disjoint
prompt injection via page/repo/tool text          no path from bytes to authority
```

One observation taken rather than fixed: a Goal Lease that lists the **v5** adapter in
`admittedAdapters` would compose with a delegation into page-text-to-filesystem-write with no human
gesture at any step. That configuration is a separate deliberate human act and neither ADR analyses
the composition end to end. It is named here so the next person does not discover it by building it.

## Residual limits

- **Issuance is a rule, not a mechanism.** `scripts/delegation-control.ts` is a script, and code
  cannot tell whose hands are on the keyboard. What is enforced is narrower and still worth having:
  nothing on the browser path can reach the control plane or the store methods behind it, because
  the dispatch plane is handed a port object that lacks them at runtime. Adding `listAdapterSessions`
  and `listWorkspacesForOwner` to the store widened nothing there — the port is built by enumerating
  the names it may carry, so a new store method is absent from it until someone lists it.
- **The human gate still lives in the browser.** The gateway cannot distinguish a clicked Run from
  an unclicked one, on v4 or v5. `run.human` is how the panel reports a click; it is not what makes
  a Run human. Unchanged by this revision, and `HUMAN_RUN` still means exactly "no delegation
  authorised this".
- **One process, one store, two surfaces.** The v4 and v5 admission registries are disjoint and
  workspaces are scoped to `(ownerId, sessionId, adapterId)`, so a v5 session cannot use a v4
  session's workspace — which is why the live proof has to open its own.
- **An extension reload breaks a delegation.** It re-mints the correlation, so the session changes
  and the binding stops matching. That is the binding working; it also means a delegation is worth
  minutes, not hours, in practice.
- **`npm run lease:stop` halts delegated Run as well**, because ADR-0029 reuses the same
  kill-switch file rather than adding a second one nobody would remember in an emergency. Verified:
  the runtime reads `dirname(statePath)` and `stateDirectory()` returns the same
  `LOCALAPPDATA\WebAgentGateway`. `scripts/lease-stop.ts` now says so — it was understating what it
  does, which is the safe direction but still inaccurate.
