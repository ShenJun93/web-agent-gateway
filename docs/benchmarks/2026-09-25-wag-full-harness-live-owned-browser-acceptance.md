# WAG Full Harness — Live owned-browser acceptance

Date: 2026-09-25
Source HEAD: 1d5908af8d2f5e60434985a31f2e1533daebf8d4
Branch: feat/full-harness-live-run-v1
Status: LIVE OWNED-BROWSER PASS / NOTEBOOK99 LIVE H3 NOT YET RUN / NOT RUNTIME-PROMOTED

## Scope

This acceptance proves the production BrowserPort composition against a real Microsoft Edge process
without using Desktop Commander, Playwright as the control plane, the user's default browser
profile, the ChatGPT side-panel Run control, or the operator Approve/Reject UI.

The run was deliberately local-only:

- WAG-owned brand-new browser profile;
- WAG-owned exact Edge process;
- headless Edge;
- loopback CDP only;
- loopback HTTP fixture only;
- semantic snapshot/action path;
- exact-once effect ledger;
- screenshot;
- exact owned cleanup.

No authenticated website or remote consequential effect was touched.

## Canonical browser preflight

Immediately before browser automation, the canonical local policy was fresh-read from:

```text
E:\AI-BROWSER\PLAYWRIGHT_HANDOFF.md
SHA256 d47a130bd6969423d19bcb939fe0b7a39cbc443cd5c97c6cbcdcb60828a92b18
```

The required first browser-control command was exactly:

```text
playwright-cli list --all --json
```

It returned parseable inventory:

```text
browsers = []
servers = []
channelSessions =
  chrome -> C:\Users\PACMAP\AppData\Local\Google\Chrome\User Data
  msedge -> C:\Users\PACMAP\AppData\Local\Microsoft\Edge\User Data
```

The normal Chrome and Edge channel profiles were treated only as topology evidence and were not
opened, attached, modified, closed, or reclaimed.

## Source hardening completed before allocation

Two source gaps were closed before the live run.

### Browser ownership receipt

Commit:

```text
602adc7de9014aaf7b5ca484cd8e3ffa076e6bdd
fix: align browser profile ownership receipt with policy
```

New WAG BrowserPort profiles retain the durable WAG authority tuple and also write the canonical
browser-policy metadata:

```text
session
caller
purpose
created_at
profile_path
```

Old version-1 OWNER.json records remain parseable for backward compatibility.

### Headless default

Commit:

```text
1d5908af8d2f5e60434985a31f2e1533daebf8d4
fix: launch owned Edge headless by default
```

Owned Edge launch plans now inject:

```text
--headless=new
```

and reserve `--headless` so callers cannot override the authority-sensitive browser visibility
mode through extra arguments.

## Reproducible harness

The live gate is implemented by:

```text
scripts/accept-full-harness-browser-live.ts
```

The harness fails closed when its profile or output directory already exists. It creates only a
brand-new exact-owned session/profile, serves a loopback fixture, verifies semantic actuation and
exact-once retry behavior, writes evidence, and closes the exact browser session/process.

Run:

```text
npx tsx scripts/accept-full-harness-browser-live.ts \
  --session wag-full-harness-live-20260925-a1
```

Exit:

```text
0
```

## Exact live evidence

Worker/profile:

```text
session:
wag-full-harness-live-20260925-a1

profile:
E:\AI-BROWSER\profiles\wag-full-harness-live-20260925-a1

output:
E:\AI-BROWSER\output\wag-full-harness-live-20260925-a1
```

Browser ownership/lifecycle:

```text
browserSessionId:
browser_9cb63db0-1c0d-4f8e-952b-bbf64b299e54

processId:
process_2f9dcd11-8979-4e37-83bf-ca0bbd76c2e3

PID:
45200

open:
ACTIVE

close:
CLOSED

processGoneAfterClose:
true

COMSPEC available to owned Edge process:
true
```

The test page was local loopback only:

```text
http://127.0.0.1:55353/
```

Exact-once effects:

```text
navigation effect:
effect_fdbaf322-0503-4c82-99af-df672b668f9a

click effect:
effect_37b7dc70-5e27-4b1f-9c34-2f7af0efb91e

click attempt:
attempt_8f75a5a7-ef77-45d8-bf37-ae3445aaff29

retry effect:
effect_37b7dc70-5e27-4b1f-9c34-2f7af0efb91e
```

The first semantic click changed the page title to:

```text
WAG BrowserPort Accepted 1
```

Repeating the same idempotency key and exact same action returned the same durable effect id. A
fresh semantic snapshot still reported:

```text
WAG BrowserPort Accepted 1
```

rather than `Accepted 2`. This is direct live evidence that the retry was not dispatched twice.

## OWNER.json evidence

Path:

```text
E:\AI-BROWSER\profiles\wag-full-harness-live-20260925-a1\OWNER.json
```

SHA256:

```text
8fcfebc0012554b151261213b12a6c5b004f1911fb276b4808a38c6e5b362b23
```

Observed policy fields:

```text
session:
wag-full-harness-live-20260925-a1

caller:
local.private.stdio/session_3d2232f6-2c0f-47bc-9048-a8f7fd11b104/private.stdio.v1

purpose:
WAG BrowserPort dedicated profile

created_at:
2026-09-25T06:33:24.105Z

profile_path:
E:\AI-BROWSER\profiles\wag-full-harness-live-20260925-a1
```

The durable WAG authority tuple is also present separately.

## Screenshot evidence

Path:

```text
E:\AI-BROWSER\output\wag-full-harness-live-20260925-a1\screenshot.png
```

SHA256 recorded by the acceptance harness and independently re-read with `certutil`:

```text
e011e8df94f0e5c8b5f425a569fc465fc5c911ca85fd593207715c11c2e1838b
```

## Durable live receipt

Path:

```text
E:\AI-BROWSER\output\wag-full-harness-live-20260925-a1\acceptance.json
```

SHA256:

```text
b44862b1c33ef6cc07dd361a484bc79e499a8cc3af75a182bcb7d4133da2968f
```

Completion time recorded by the harness:

```text
2026-09-25T06:33:41.422Z
```

## Post-run coexistence check

After exact BrowserPort close, `playwright-cli list --all --json` again reported:

```text
browsers = []
servers = []
```

with only the same pre-existing Chrome/Edge channel profiles. No other browser worker was cleaned
up or adopted.

## Source gates on the accepted candidate

Fresh after the policy hardening and before/after live execution:

```text
npm run build       PASS
npm run typecheck   PASS
git diff --check    PASS
```

Full Harness regression:

```text
31 + 32 + 31 + 31
= 125 / 125 PASS
0 FAIL
```

Current autonomous-local/core regression:

```text
16 / 16 PASS
0 FAIL
```

## What this closes

The following are now live-proven on real Edge rather than source-only:

- brand-new dedicated profile ownership;
- policy-complete OWNER.json;
- owned headless Edge launch;
- WAG ProcessPort ownership;
- loopback-only CDP readiness and attachment;
- semantic accessibility snapshot;
- semantic action through DOM identity;
- durable exact-once browser effect;
- idempotent retry without duplicate actuation;
- bounded screenshot;
- exact BrowserPort close;
- exact owned Edge process termination.

## Remaining gate before runtime promotion

Notebook99 live H3 remains intentionally unclaimed.

The existing `Notebook99Driver` is currently an injected interface used by the exact-once
acceptance coordinator and tests; there is not yet a production concrete Notebook99 site driver.
An authenticated, exact-owned WAG browser profile has also not yet been proven.

The clean next step is therefore:

1. implement and source-gate a concrete BrowserPort-backed Notebook99 driver;
2. prove ownership of a dedicated authenticated WAG profile, using a human login/bootstrap only if
   authentication requires it;
3. run one bounded exact-once H3 transaction;
4. only after that gate, consider runtime promotion.

No Git push or other remote Git authority is granted by this receipt.
