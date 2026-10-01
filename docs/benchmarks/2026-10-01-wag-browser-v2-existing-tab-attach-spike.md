# WAG Browser v2 — Existing-Tab Attach Feasibility Spike

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Baseline commit: `50e831ff491a792a6d4953a326ea5ce030bd8a15`

## Result

```text
BROWSER_V2_EXTENSION_ATTACH_FEASIBILITY = PASS
REAL_EDGE = PASS
TEMPORARY_PROFILE_ONLY = YES
USER_EXISTING_PROFILE_ACCEPTANCE = NOT EXECUTED
NATIVE_RUNTIME_CONTROL_BRIDGE = NOT IMPLEMENTED
```

The feasibility question was whether WAG can use a Chromium extension as the first-class transport for `ATTACH_EXISTING`, avoiding foreground-dependent UIAutomation and avoiding attempts to launch the user's default profile with a remote-debugging port.

The answer is yes.

## Implemented spike foundation

The shipped extension branch now includes:

```text
permissions:
  debugger
  tabs
```

in addition to the existing nativeMessaging/operator permissions.

A new internal controller:

```text
browser/extension/existing-browser-control-v1.js
```

implements bounded primitives for:

- focus-free tab discovery;
- sanitized target metadata;
- exact-tab debugger attach;
- an allowlisted `Page.getFrameTree` probe;
- debugger detach/release;
- local attachment-state invalidation on external debugger detach.

It does **not** expose a raw CDP command surface to MCP.

## Privacy behavior

Discovery/probe output:

- accepts only `http:` and `https:` pages as attachable;
- strips URL username/password;
- strips query strings;
- strips fragments;
- bounds title length;
- does not return cookies, auth tokens, profile paths, or debugger transport details.

## Unit evidence

Focused extension/controller suite:

```text
26 / 26 PASS
typecheck = PASS
git diff --check = PASS
```

Covered:

- focus-free discovery;
- exact tab attach/probe/release;
- target remains open after release;
- external detach invalidates local attachment state;
- non-web targets fail closed;
- missing targets fail closed;
- structured attach errors;
- query/fragment/credential sanitization;
- existing v4 operator behavior remains intact.

## Real Edge smoke

Executable:

```text
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

The harness creates:

- a temporary Edge user-data directory;
- a temporary unpacked extension using the production controller module;
- a loopback HTTP fixture;
- an inactive target tab;
- a separate active extension result tab.

No existing user Edge profile is used.

Observed final receipt:

```json
{
  "activeStable": true,
  "attached": true,
  "discovered": true,
  "querySecretLeaked": false,
  "released": true,
  "status": "PASS",
  "targetStillOpen": true,
  "targetWasActive": false,
  "usedTemporaryProfile": true,
  "usedRealEdge": true,
  "browserClosedByRelease": false
}
```

The loopback port is intentionally ephemeral and is not a product identity.

## What this proves

The extension path can:

1. enumerate an existing web tab;
2. select an inactive tab without making it foreground;
3. attach `chrome.debugger` to the exact tab;
4. issue a bounded debugger command;
5. preserve the active tab while attached;
6. detach;
7. leave the target tab/browser alive.

Therefore:

```text
ATTACH_EXISTING_TRANSPORT_DIRECTION = EXTENSION_DEBUGGER_FIRST
PROCEED_TO_BROWSER_BROKER = YES
```

## What this does not prove

The following remain explicitly unproven:

- attachment to the user's real authenticated default Edge profile;
- enterprise policy behavior;
- browser warning/banner UX under normal installed-extension use;
- native WAG runtime -> extension control protocol;
- durable per-target ownership/fencing;
- multi-session attach isolation;
- OAuth/new-tab target continuity;
- cross-runtime browser-session recovery.

These remain Browser v2 implementation/acceptance work, not claims of the feasibility spike.
