# The live stack is up, and the activation step is prepared

2026-09-21. Branch `feat/goal-ui-delegation-v1`. No grant issued, named, widened, renewed or
revoked. HKCU untouched.

## What was done without a human

| | |
| --- | --- |
| Pinned DevSpace | started from `docs/benchmarks/devspace-pin.json` rev `33d6d0b`, listening on `127.0.0.1:7676`, PID tracked |
| WAG browser operator | started against the live config, `gateway.ready`, PID tracked |
| v5 surface | discovery written, `adapterId=browser.chatgpt.native.delegation.v5`, protocol 5, its **own** admission port (v4 and v5 never share one) |
| Placeholder | honoured — the runtime logs `gateway.goalUiDelegation` with the placeholder id and the note that Approve is unchanged |
| Restart / recovery | WAG stopped and restarted; new admission port, new bootstrap token, v5 surface rebuilt |
| Edge worker | brand-new profile `wag-op-4`, extension side-loaded, 2 extension renderers confirmed |
| v5 sessions | **zero, deliberately** — see below |

### The DevSpace owner token is not a human secret

`DEVSPACE_OAUTH_OWNER_TOKEN` reads like a credential and is not one. It is a value *given to* the
local DevSpace server at startup and to the WAG gateway that talks to it — a shared secret between
two loopback processes, both of which this session may start. The test fixture uses a hard-coded
constant for exactly this reason.

So it was generated per run, kept in the session scratchpad at mode 0600, passed only through the
child environment — never a command line, where a process listing would expose it — and never
printed. **The human-only secret injection for DevSpace reduces to nothing.**

### A measured defect: the discovery file is not removed on a hard kill

`closeDelegation()` removes the v5 discovery file, but only on the graceful path. After
`Stop-Process -Force` the file survived, carrying a bootstrap token and an admission URL.

Consequence, measured rather than reasoned: the port it names is dead, nothing binds it, and the
next connection fails `ensureReady` and stays on the human path. Fail-closed. The file is
overwritten with a fresh port and token on restart.

This is **pre-existing and not v5-specific**: `browser-adapter-v4.json` was already on disk before
anything was started today, left by an earlier run's shutdown. Recorded as a residual rather than
repaired, because a fix is new mechanism and the failure direction is safe. The narrow exposure
worth naming: if the dead port were later bound by an unrelated process, a stale token would be
POSTed to it.

## Why no v5 session was minted

A v5 session can be created by anything that reads the discovery file and speaks `session.bind` —
including this session, which holds the same filesystem access. That was not done, on purpose.

The session id is what a delegation binds. If a session existed that the production browser had not
created, the activation step would face two v5 sessions and no way to tell which one the extension
is actually using — and binding a grant to the wrong one would either waste the grant or, worse,
bind it to a session Claude controls. Leaving the table empty makes the first session that appears
unambiguously the extension's, and the activation step asserts exactly that.

Stated plainly because it is a real property of the design: **holding the discovery file is enough
to mint a v5 session and stage proposals claiming an allowed origin.** That is same-user access,
which ADR-0019 already places outside the containment claim, and the budget is the bound. The
activation step's ambiguity refusal is what keeps it from mattering here.

## The single human activation step

`docs/pending/activate-delegation-control.mjs`, verified by `test/activation-step.test.ts` (11
tests). It issues one bounded delegation, names it in the live config, and issues one matching
lease for the same goal.

**Claude cannot run it, and that is built rather than promised.** The file name matches the applied
guard's issuance pattern, so `node docs/pending/activate-delegation-control.mjs --issue …` is
refused at the tool layer — asserted by driving the live guard, alongside an assertion that a
differently named copy would *not* be refused, so the coupling is visible instead of incidental. A
second layer refuses a non-interactive stdin.

Write order makes every partial failure safe:

```text
issue -> verify -> name in config -> issue lease -> verify both
         |                  |
         |                  +-- fail here: Run enabled, no lease. Every effect still needs
         |                      the operator. Safe.
         +-- fail here: a delegation not named in configuration, which is inert. Safe.
```

Refusals, each fired against a real temporary store rather than described: no v5 session, more than
one, a session that is not the one passed, a session older than two hours, a config that no longer
holds the placeholder, a missing reference, a workspace outside `allowedRoots`, a detached or
protected branch, an engaged kill switch, and any stored binding that does not read back identical
to the intended one.

Every bound is strictly inside the ceiling the policy would allow — 2 h against 4, 4 h against 12,
8 actions, 4 files — and the lease tool set is asserted to be a subset of the delegated one, so the
lease cannot widen the run. `workspace.open` is asserted absent, because it resolves no
`workspace_id` and a delegation cannot constrain it.

## The remaining boundary, and why it is not one I can cross

The extension's content script runs on `https://chatgpt.com/*` and nowhere else. A v5 session is
minted only when it observes a provider message whose parsed call carries a `workspace_id`. So the
candidate needs a signed-in conversation.

Two sub-blockers, both genuine:

1. **Profile ownership.** `wag-op-2` and `wag-op-3` have the extension and a login, and their
   `OWNER.json` names session `3c30933c`. This is session `859f9b5c`. The browser rule is explicit
   — a previously used profile may be reopened only by the worker that already proved it owns it,
   and if ownership cannot be proven, leave it alone and say so. So they were not opened.
2. **The login itself.** A brand-new worker was allocated instead — `wag-op-4`, extension loaded,
   confirmed by two extension renderers, `chatgpt.com` open. It has no session, and signing in is
   auth consent and identity verification, which is never automated.

Everything up to the login is done. The login is the smallest remaining act, and it is the same
class of boundary as the grants: a secret this session may not handle.
