# A real DELEGATED_RUN happened — and then hit a structural dead end

2026-09-22. Branch `feat/goal-ui-delegation-v1`. **`WAG_DC_REPLACEMENT` is not PASS.**

The production browser proof reached further than ever before and then stopped on a gap that no
amount of retrying would clear. Implementation stayed frozen, per instruction: the failure is
classified below, and nothing was changed.

## What was achieved, for the first time

A human submitted one prompt in the signed-in task-owned ChatGPT window. No Playwright, no CDP,
no simulated click. The extension observed it and WAG admitted it:

```text
run_authority
  proposal_id   prop_6a8c21fe064005021c7b8d23
  authority     DELEGATED_RUN
  goal_id       goal_delegated_run_mublonyf
  delegation_id uidel_8001e926a35d4e9affcdb0f0
  controller_id local.operator.cli
  tool          mutation.preview
  workspace_id  ws_4e2d106c-9023-40d0-a734-f6fa18711ee0
  session_id    session_6cc39863-0a17-4602-a0ad-a0c6eb8f8525
  adapter_id    browser.chatgpt.native.delegation.v5
  origin        https://chatgpt.com
  result_id     null
```

**An untrusted page's text became a WAG proposal with no human clicking Run**, authorised by a
delegation a human issued out of band and named in configuration. That is ADR-0029's central claim,
demonstrated in production rather than in a fixture.

### Replay protection also fired, in production

Two re-observations of the same logical action were refused:

```text
delegated_run_refusals   PROPOSAL_REPLAY  slot_claimed=0  x2
delegation_claims        1
```

Both refused **after** staging, by the CLAIM transaction — the guarantee layer, not the fail-fast —
and both spent nothing. Exactly what `delegated-run-replay-durability.test.ts` predicted, now
observed against the live gateway with a real browser.

## Where it stopped, and why retrying cannot help

`result_id` is null and no mutation row exists. The run was admitted, a budget slot was spent, the
audit row was written — and then execution could not succeed.

```text
workspaces.ws_4e2d106c…  session_id  session_13150a33-…
                         adapter_id  browser.chatgpt.native.operator.v4

the delegated caller     session_id  session_6cc39863-…
                         adapter_id  browser.chatgpt.native.delegation.v5
```

`sameAuthority` in `admitted-workspace.ts` requires `ownerId`, `sessionId` **and** `adapterId` to
match, so the v5 session is denied that workspace. Measured across the whole store:

```text
workspaces by adapter:  browser.chatgpt.native.operator.v4   13
                        browser.chatgpt.native.delegation.v5  0
```

**No v5-owned workspace exists, and nothing in the shipped system can create one.**

- `workspace.open` takes a `path`, not a `workspace_id`, so `validateStageableArguments` refuses it
  on the delegated path by design — a delegation's workspace binding cannot constrain it.
- The v5 human-Run verb exists but the shipped side panel still drives v4, so a human Run opens a
  **v4**-owned workspace. This was already recorded as a residual gap in the 2026-09-21 handoff.

So a delegated Run can only ever act in a workspace the v5 session itself opened, and there is no
route by which a v5 session can open one.

## Classification

**The ownership refusal is correct and must not be weakened.** Workspace ownership is one of the
invariants the mandate protects, and a v5 session silently inheriting a v4 session's workspace
would be precisely the cross-context authority leak the design exists to prevent.

**The blocker is upstream of it, and it is a WAG-side design gap rather than a page or provider
problem.** The candidate reached v5; WAG admitted it, spent a slot and wrote a `DELEGATED_RUN` row
for work that could never complete. The gap is that **a delegation can be issued naming a workspace
its bound session does not own**, and nothing refuses that — not the control plane at issue time,
not the dispatch plane at stage time, and not the activation instrument I wrote, which checked that
the workspace exists and that its root is allowed but never that the session owns it.

The honest cost of the gap, measured: one of eight budget slots spent, one audit row asserting a
delegated Run, `staged_proposals` left `DISPATCHED`, no effect, and — correctly — no way to retry,
because single-assignment state means a `DISPATCHED` row never returns to `STAGED`.

## What a fix would have to be, stated but not built

Implementation is frozen, so this is a proposal and nothing was changed:

1. **Refuse at issuance.** The control plane should reject bindings whose `workspaceId` is not owned
   by the bound `sessionId` and `adapterId` — the cheapest place, and the one where a human is
   already present.
2. **Refuse at staging**, for the same reason `requireWorkspaceBinding` exists: a candidate naming a
   workspace this session cannot resolve is not stageable, and refusing before the CLAIM means the
   dead end costs nothing.
3. **Then** decide separately how a v5 session acquires a workspace at all — the v5 human-Run path
   on the shipped panel is the obvious candidate and is already a recorded residual.

(1) and (2) are narrowing and cheap. (3) is a design decision that belongs in its own milestone.

## Gate status

Everything else stayed green through this run: the stack restarted cleanly onto both grants, the
composition held, replay protection worked, and the durable record is exactly consistent with the
above. No source was changed after the freeze.

```text
WAG_DC_REPLACEMENT = FAIL   the chain stops at the leased mutation; verify, bounded commit,
                            restart/recovery under load and the DC matrix were never reached
WAG_PRIMARY        = not asserted
DC_FALLBACK_ONLY   = not asserted
```
