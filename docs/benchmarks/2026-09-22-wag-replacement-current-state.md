# Current state — WAG replacement accepted

2026-09-22. Read this first. It is short on purpose; the evidence lives in the receipts it points at.

```text
WAG_DC_REPLACEMENT = PASS
WAG_PRIMARY        = YES
DC_FALLBACK_ONLY   = YES
```

Accepted on the strength of a live production chain, not a fixture:

```text
untrusted page text
  -> DELEGATED_RUN        (ADR-0029, no human clicked Run)
  -> POLICY_APPROVED      (ADR-0028, no human clicked Approve)
  -> file effect on disk  (bytes hash to the recorded result)
  -> verify               (configured profile, green)
  -> DELEGATED_RUN        (git.commit)
  -> POLICY_APPROVED      (leased commit admission)
  -> Git HEAD 1c1297e8    (single parent = the HEAD the lease pinned, README.md only)
  -> restart / recovery   (snapshot identical)
  -> replay refused       (4 × PROPOSAL_REPLAY, slot_claimed=0)
  -> zero Desktop Commander calls
```

**The evidence:** `docs/benchmarks/2026-09-22-delegated-run-to-leased-effect.md`, preserved at commit
`41e5021`. That file carries the durable row ids, the Git verification, the restart comparison, the
gate results and the final acceptance matrix.

## Authority state: none in force

Both grants were unnamed from the live config at closure, which makes them inert whatever their rows
say. Neither was revoked — `human-presence-boundary.md` places delegation revocation outside what
this agent may do — so they are left fail-closed and will expire on their own:

```text
uidel_d919f3f60522bb3b71f05e22   expires 2026-09-22T00:09:43Z   3 of 8 actions used
lease_mubsstqa_5e468457          expires 2026-09-22T02:09:42Z
config goalUiDelegationId        uidel_PLACEHOLDER-NOT-ISSUED-0000000000000000
config goalLeaseId               absent
```

With nothing named, ADR-0026 holds in full: every effect needs Run and Approve from a person.

## What was fixed to get here

| Commit | Defect |
| --- | --- |
| `382ba79` | A delegation could name a workspace its bound session did not own. Staging and dispatch now refuse before the CLAIM, so an impossible run costs no budget slot. |
| `703109c` | Activation required "exactly one fresh v5 session" — unsatisfiable, because one extension reload mints three and a session's age never resets. Now requires the newest. |
| `e013243` | `DurableCommitCoordinator.admitByPolicy` was never called by any pass, so a configured lease admitted mutations and silently never admitted a commit. Both runtimes now drive it. |

## Explicitly not proven — do not read the PASS as covering these

- **Extension-side suppression-cache idempotence.** One cache entry was deliberately released under
  explicit operator authorisation during the run, so that property was not under test. WAG's durable
  replay protection is what the PASS rests on, and it was never touched.
- **Human authorship of the page text.** The prompts were composed by the agent and submitted by a
  person. What is proven is the Run *transition* — WAG turned untrusted page text into a proposal
  with nobody clicking Run — not who wrote the request.
- **A WAG verify job.** The verify step executed the configured profile's argv locally against the
  mutated tree. There is no `verify.run` record in the chain.

## Residuals carried forward, not reopened

- Four hand-written copies of `sameAuthority` remain outside `src/authority-tuple.ts`:
  `admitted-workspace.ts`, `browser-verify-request.ts`, `durable-verify-job.ts`, `durable-store.ts`.
  The module's header names all four as the place they should converge.
- The shipped side panel still drives v4, so a human Run there opens a v4-owned workspace. The
  activation instrument mints the v5 workspace, so this blocks nothing.
- Extension diagnostics are unproven in production. A CDP recorder attached to one service worker
  does not survive MV3 recycling, so records from a recycled worker are not captured. This is a
  limitation of the recorder; it is **not** established as a WAG defect.
- chatgpt.com renders code blocks into a virtualised viewer. A freshly completed turn can read as
  empty until it hydrates; a tab reload materialises it. Observed twice, cost two observations.
- Two `OPEN:` harness-guard TODOs predate this mission and are unrelated to it.

## Environment at closure

Every task-owned process was stopped: the WAG browser operator, the pinned DevSpace, the v5 native
host, and the Edge acceptance worker together with its CDP port 9333. Nothing task-owned is
listening. The acceptance workspace at `E:/AI-BROWSER/wag-acceptance/workspace` is left on branch
`work` at `1c1297e8`, which is the proof artifact.
