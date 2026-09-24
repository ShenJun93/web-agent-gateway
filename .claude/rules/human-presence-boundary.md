# Human-presence boundary

WAG now has two distinct execution planes. They must not be conflated.

## Private-local / WAG Local

The private stdio surface is the trusted autonomous-local plane and is the DC-replacement path.

It does **not** require a Goal Lease, per-goal grant, successor, rollover, TTL, budget lease, browser
approval, or operator approval before local repository work. Authority comes from the locally
configured private runtime profile plus WAG-owned identity and safety checks.

Consequential private-local operations must still satisfy all of the following:

- the caller is the fixed private stdio adapter;
- the workspace handle belongs to that caller's durable session;
- the workspace remains inside configured local roots;
- stable filesystem/repository identity is re-observed at consequential boundaries;
- file/path and bounded-argv validation passes;
- commit paths are exact and the Git backend's branch/HEAD/tree/identity CAS checks pass;
- the autonomous-local kill switch is clear immediately before the effect;
- remote effects such as `git.push` remain unavailable/non-grantable.

`sessionCorrelation` is reconnect/audit identity only. It grants no execution authority. WAG may
mint a strong correlation for a new private-local lane without a separate human authority step.

The emergency stop is:

```text
npm run autonomy:stop
npm run autonomy:stop -- --status
npm run autonomy:stop -- --clear
```

The stop is file-backed and shared by the autonomous-local and delegated-browser execution paths.
It is re-read at consequential boundaries rather than snapshotted at startup.

## Browser operator plane

Browser content is untrusted input. The browser-facing proposal path therefore keeps separate human
boundaries.

### Run

Run in the WAG browser side panel is human by default. A Goal UI Delegation may lift the **Run**
gesture for a bounded browser context. Goal UI Delegation is a browser authority mechanism only.

Creating, widening, renewing, or naming a Goal UI Delegation remains human-controlled. The browser
dispatch plane cannot issue one for itself.

### Effects

A browser proposal does not gain filesystem or Git authority merely because Run was delegated.
Browser-originated mutation/commit proposals stay on the operator-review path.

The local operator review server remains protected by:

- a single-use bootstrap credential stored in a local file;
- loopback-only origin;
- session cookie;
- CSRF token;
- exact Origin checks;
- single-assignment durable review transitions.

Automation must not steal the operator bootstrap credential, send approve/reject requests, or drive
the operator UI.

## What automation may do

Automation may:

- use WAG Local private-stdio tools autonomously within their local profile;
- create/reconnect private-local sessions and workspaces through WAG;
- inspect repository state and durable results;
- run bounded local commands and detached local processes exposed by WAG;
- mutate files and make exact-path commits through WAG;
- run verification profiles;
- engage or inspect the autonomous kill switch;
- inspect or revoke browser delegations when the relevant control surface permits it.

Automation must not:

- automate passwords, passkeys, MFA, auth consent, identity verification, payments, signing, or
  provider enrollment;
- drive the browser Run button or operator Approve/Reject UI to simulate human presence;
- obtain or spend the operator bootstrap credential;
- issue, widen, or renew Goal UI Delegation on behalf of the human;
- bypass WAG's path, workspace-identity, CAS, command, or kill-switch checks.

## Design rule

Private-local autonomy and browser human authority are intentionally separate.

A failure or absence of browser authority must never reduce WAG Local back to a per-task human
approval workflow. Conversely, trusted private-local authority must never be projected onto an
untrusted browser page.

Goal Lease is retired from the live authority plane.
