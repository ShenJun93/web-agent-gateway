# Handoff — Goal UI Delegation (ADR-0029), production wiring

2026-09-21. Branch `feat/goal-ui-delegation-v1`. **Nothing pushed.** Working tree clean.

## What this milestone did

Made an active `/goal` able to turn an untrusted page's text into a WAG proposal **without a person
clicking Run** — using a separate deterministic authority a human granted out of band, not by
automating the gesture.

`.claude/rules/human-presence-boundary.md` now separates two invariants that used to be one:

```text
APPROVAL                = HUMAN_UNLESS_A_VALID_LEASE_ADMITS_THE_ACTION
RUN                     = HUMAN_UNLESS_A_VALID_UI_DELEGATION_ADMITS_THE_PROPOSAL
UI_DELEGATION_SCOPE     = RUN_ONLY_NEVER_APPROVE
UI_DELEGATION_ISSUANCE  = HUMAN_ONLY_AND_OUT_OF_BAND
NOTHING_CONFIGURED      = ADR_0026_UNCHANGED_IN_FULL
```

**A human applied that patch, out of band.** Claude's own `Edit` was refused by the settings deny
list and Claude did not escalate to a shell. That refusal is the design's central evidence, not an
obstacle it worked around: the file governing whether Claude's automation may cause a Run is one
Claude cannot write.

## Commits

```text
a92493f  fix: retire the rule-patch applier — it kept a second copy of a rule file in scripts/
7c6a0d3  fix: close all eight findings from the fourth review, including two the design claimed
1a22944  docs: the production wiring receipt — two defects the design had, found by building it
a96b018  docs: 20 more mutations for the production wiring, and the five gaps they found
c30985f  test: prove a live DELEGATED_RUN through the production runtime, and what a crash costs
7f8aec4  feat: wire delegated Run into production — the six pieces, and the defect they exposed
6577372  docs: reconcile the two digests over the patch document, and name both
92f1c0f  chore: apply the human-presence boundary patch — applied by a human, not by Claude
e7c6e5c  chore: a verified applier for the delegation rule patch, for a human to run   [retired in a92493f]
e3e65ed  feat: delegated-dispatch transport, and the fixture-lane proof that it works
5d2654b  feat: goal UI delegation — the authority that replaces the click, twice reviewed
1edff16  feat: the delegation coordinator, where replay is refused by the database
b07dc6f  feat: goal UI delegation policy — the authority that replaces the click
```

## Exact digests

```text
.claude/rules/human-presence-boundary.md
  before  210becf3015bb993653935457e7c8fe57ce99a514c69c22fe5fee6cea4e90562
  after   7355153a8a89684e89c4dda6f42f7c0ed3451965ef7d6bbd3fa03838e4a4b2a9
.claude/rules/wag-primary-operator.md
  before  8e16910d5808694235de50e83b87eaec7e1bca3ce777f09c0aadeb3e9ae863d9
  after   70d08a13764b8473f00f30d2dd80ec17353f68bbd389d35242c3f9033dba797c

docs/pending/human-presence-boundary-goal-ui-delegation.md
  raw bytes      35b3ff68b929ae35ca6e8f3f27d1e8e4f88830029d4ddd340365f5496f25caac
  patch payload  bedf154361e8bd23dae8173cc8ce6594fa9c38cea097c17ec18422e6e2fd67de
```

**Two digests over the patch document, and they are not interchangeable.** `sha256sum` and
`Get-FileHash` cover the raw bytes; the authorised value covers the file with its own `sha256(...)`
line removed, because a digest cannot cover itself. A review flagged the mismatch as a discrepancy;
it is not one, but neither number should ever be called "the file's SHA256" unqualified.

```bash
npx tsx scripts/verify-delegation-rule-patch.ts
```

## Gates

| Gate | Result |
| --- | --- |
| `npm test` | **755 tests, 749 pass, 0 fail, 6 todo, exit 0** (1017 s) |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm run test:goal-lease` | 2/2 — a bounded lease executes a real mutation with no Run and no Approve |
| `npm run test:dc-replacement` | 1/1 |
| `npm run test:business` | 1/1 |
| `npm run test:delegation-e2e` | 15/15 |
| `npm run test:delegation-mutations` | **113 mutations, 107 caught, 6 redundant-by-design, 0 survived, 0 inconclusive** |
| `npx tsx scripts/verify-delegation-native-host.ts` | 12/12 — the built `.exe` over real stdio |
| `npx tsx scripts/verify-delegation-rule-patch.ts` | boundary and patch digests all match |
| `.claude/` untouched by Claude | `git status --porcelain -- .claude/` empty throughout |

The 6 todos pre-date this milestone. One is the documented quadratic-backtracking guard issue
(`OPERATOR_URL_FILE` backtracks, so an 80 KB command exceeds the hook timeout) — a platform property
recorded in `human-presence-boundary.md`, not a regression.

**`npm run test:operator-browser` was not re-run.** It is a browser-backed regression for the
*operator's* CSRF Origin check, and its subject is untouched by this milestone — `git diff
--name-only b07dc6f^..HEAD -- src/operator-server.ts src/http-server.ts browser/extension/sidepanel.js`
is empty. It needs an owned Playwright worker, and `resource-policy.md` warns against browser
profiles that are not needed. Stated rather than quietly skipped.

## What is proved, and at which layer

```text
policy                 evaluateDelegatedRun, pure, over durable rows            136 tests
transport              router, host, link, loopback server                       14 tests, real framing
production runtime     startBrowserOperatorRuntime, real MCP tools                3 tests
built artifact         wag-native-host-v5.exe spawned as Chrome spawns it        12 checks
extension logic        idempotence, indeterminate dispatch, memory               10 tests
recovery               sweeper, crash states, restart, executor guards           17 tests
```

The live `DELEGATED_RUN` proof runs the **shipped runtime**: real config loader, real store, real v5
admission server, real native host over streams, and the same MCP server a clicked Run reaches.
`repo.search` finds a real needle in a real git-tracked file, with nobody clicking anything, and the
audit row says `DELEGATED_RUN` beside a `HUMAN_RUN` from the same test.

## How to turn it on

Both steps are human acts, deliberately. Claude may *use* a delegation and must *report* on one; it
may not issue one, and naming one in configuration is proposing to grant itself authority.

```text
1. name a placeholder in repositoryEngineering.mutation.goalUiDelegationId, start WAG
   (a placeholder names no row, so every dispatch is refused DELEGATION_NOT_FOUND)
2. connect the extension — WAG mints the v5 session
3. npx tsx scripts/delegation-control.ts --sessions      find it
   npx tsx scripts/delegation-control.ts --issue \
     --goal <id> --session session_... --workspace ws_... \
     --tools repo.search,file.read --origin https://chatgpt.com \
     --max-actions 20 --ttl-minutes 60
4. put the printed id in goalUiDelegationId, restart WAG
```

Step 4's reconnect returns the **same** session, because a session is keyed by the correlation the
extension holds in `chrome.storage.session`. An extension *reload* re-mints that correlation, so the
delegation stops matching and must be reissued — the binding working, not a defect. In practice a
delegation is worth minutes, not hours.

For a **browser-level** run you additionally need the v5 native host registered:

```bash
npm run build:delegation-native-host
npx tsx scripts/verify-delegation-native-host.ts
```

then register `artifacts/delegation-adapter/com.openai.web_agent_gateway_v5.json` under the Edge
HKCU `NativeMessagingHosts` key, as the v4 host already is. **Not done on this machine.**

## Stop

```bash
npm run lease:stop
```

Halts every Goal Lease admission **and** every delegated Run on the next call, in every WAG process,
without any of them cooperating. ADR-0029 reuses the same kill-switch file rather than adding a
second one nobody would remember in an emergency. It pauses; it does not revoke. It deliberately does
not block the human route.

## DC replacement matrix

`WAG_LOCAL_OPERATOR = PRIMARY`, `DESKTOP_COMMANDER = FALLBACK_ONLY`. Desktop Commander is denied in
`.claude/settings.json` and never appears in an acceptance path.

| Workflow | WAG surface | Run | Approve | State |
| --- | --- | --- | --- | --- |
| Discover a repository | `repo.list`, `repo.search`, `repo.snapshot` | human or delegated | n/a — read only | **covered** |
| Read a file | `file.read` | human or delegated | n/a — read only | **covered** |
| Propose an edit | `mutation.preview` | human or delegated | operator, or a Goal Lease | **covered** |
| Create a file | `file.create` | human or delegated | operator, or a Goal Lease | **covered** |
| Commit an exact path set | `git.commit` | human or delegated | operator, or a Goal Lease | **covered** |
| Run a verification | `verify.preview` / `verify.run` | human | n/a | **covered** |
| Read a result | `*.result` | human or delegated | n/a | **covered** |
| Open a workspace | `workspace.open` | **human only** | n/a | covered, and *not* delegatable |

`workspace.open` cannot be delegated by design: it takes a `path`, not a `workspace_id`, so a
delegation's workspace binding cannot constrain it. Allowing it would have produced a delegation that
reads narrow and behaves wide — a defect this milestone found and closed. `health` is excluded for
the same mechanical reason.

**Where Desktop Commander is still the fallback**, and why:

| Gap | Why WAG cannot do it today |
| --- | --- |
| Arbitrary shell | Deliberately absent. WAG's surface is proposal-only; a shell is the thing ADR-0019 declines to expose to browser-reachable authority. |
| Results back to the page | Still manual relay. Results go to the side panel; a human carries ids back to the chat. The first thing a successor should remove. |
| Anything outside `allowedRoots` | Config-level bound, unchanged. |
| Process management | Not a WAG capability and not proposed as one. |

Re-enabling DC is a deliberate act: allowed only after WAG has genuinely failed an already-accepted
workflow, with the failure and the fallback both written down.

## Residual gaps

1. **The browser-level delegated Run has not happened.** The v5 native host now builds and is proved
   to speak the protocol over real stdio, but it is not registered on this machine, and issuance plus
   configuration are two human acts. Everything below that boundary is proved through the shipped
   runtime.
2. **`run.human` is not on the shipped human path.** `runAsHuman` has no caller in the extension: when
   the delegated path declines a candidate, the worker falls through to a v4 `tool.call` and the panel
   executes it over the v4 port. So no `HUMAN_RUN` row is written in production today. Left that way
   deliberately — rewiring the accepted human path buys no authority and risks the route everything
   else falls back to.
3. **Issuance has a rule and no tripwire.** `.claude/hooks/wag-human-gate-guard.mjs` has no pattern
   matching `delegation-control`, `--issue` or `goalUiDelegationId`, and no deny rule covers them.
   Verified: it has no **lease** patterns either, so this is not delegation being singled out —
   neither authority had a production issuance path until `scripts/delegation-control.ts`, and a
   tripwire for a path that did not exist would have matched nothing.

   **Claude cannot close this.** Writes under `.claude/` are denied, and routing around that denial is
   the one thing this milestone exists to demonstrate Claude will not do. For a human, the minimal
   addition is a shell-command pattern alongside the existing ones:

   ```text
   delegation-control            any invocation of the issuance CLI
   goalUiDelegationId            any command that would name a delegation in configuration
   ```

   It is a request to *tighten* a control, which is legitimate to propose and not to apply.
4. **Issuance is a rule, not a mechanism.** `delegation-control.ts` is a script and code cannot tell
   whose hands are on the keyboard. What *is* enforced: nothing on the browser path can reach the
   control plane or the store methods behind it, because the dispatch plane holds a frozen port
   object that lacks them at runtime. ADR-0019 already places a same-user adversary outside the
   containment claim.
5. **A lease listing the v5 adapter would compose.** A Goal Lease whose `admittedAdapters` includes
   `browser.chatgpt.native.delegation.v5`, combined with a delegation, would be the first
   configuration in this project where page text reaches a filesystem write with no human gesture at
   any step. Both are separate deliberate human acts and neither ADR analyses the composition end to
   end. Named here so the next person does not discover it by building it.
6. **The host's request budget is per-session, not per-time.** `seen` clears only on
   `session.unbind`, so a long-lived tab hard-stops at 4096 v5 frames with `TOO_MANY_REQUESTS`.
   Fail-closed, availability only, untested.

## Four adversarial reviews

All findings closed or explicitly left open with a reason.

| Review | Subject | Findings |
| --- | --- | --- |
| 1 | the policy | 17, all CLOSED |
| 2 | the repair | 9, all CLOSED |
| 3 | the transport | 9, all CLOSED |
| 4 | the production wiring | 8 — 7 CLOSED, 1 open by design (residual 3) |

The recurring defect class across all four is **confident prose over an absent or unreached
mechanism**, and in reviews 2, 3 and 4 the instances were in prose written during the *previous*
repair. Review 4's two HIGH findings were both of that class, and one of them was in the section
written to announce the class was gone.

The countermeasures that actually caught things, in order of how much they found: building the
thing (2 design defects three reviews missed), mutation testing (7 survivors plus one stale anchor
scoring as caught while mutating nothing), and independent adversarial review. Reading the code again
found nothing the first three had not.

## Receipts

- `docs/benchmarks/2026-09-21-goal-ui-delegation-design-gate.md` — the design gate, reviews 1–3
- `docs/benchmarks/2026-09-21-goal-ui-delegation-boundary-patch-applied.md` — the human-applied
  authority change, verified after the fact, and both digests
- `docs/benchmarks/2026-09-21-goal-ui-delegation-production-wiring.md` — the wiring, review 4, and
  the two defects building it exposed
- `docs/adr/0029-goal-ui-delegation-v1.md` — the decision
