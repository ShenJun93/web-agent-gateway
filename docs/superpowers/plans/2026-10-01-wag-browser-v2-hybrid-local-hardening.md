# WAG Browser v2 — Hybrid Local Browser Reliability & Existing-Session Control Hardening

**Date:** 2026-10-01  
**Status:** canonical implementation plan for public-launch P0

## Purpose

Harden WAG so it can act as the primary self-sufficient local/browser automation layer for day-to-day ChatGPT work without requiring Desktop Commander, TinyFish, global foreground focus or PowerShell UIAutomation for normal authenticated web workflows.

The plan originates from the real Superteam/Mermail production workflow on 2026-09-30, where WAG ultimately completed authenticated navigation, form filling, X OAuth, submission and final-state verification, but only after friction around session/profile ownership, UI focus and framework input semantics.

The target is not arbitrary browser feature growth. The target is reliable ownership, modern-form semantics, OAuth continuity and recovery.

## Operating contract

- Work autonomously between STOP points.
- Preserve current BrowserPort behavior and exact-once effect semantics.
- Do not weaken security boundaries to improve automation convenience.
- Do not depend on Desktop Commander or TinyFish for implementation or verification.
- Treat live repository state as canonical when it differs from older handoff text.
- Keep `docs/progress/PUBLIC-LAUNCH-P0-RUN.md` current.
- Do not public-push during this lane.

## Required architecture

```text
                         WAG BrowserBroker
                               |
           +-------------------+-------------------+
           |                   |                   |
    ATTACH_EXISTING       WAG_VISIBLE        WAG_HEADLESS
           |                   |                   |
 Browser Extension        Managed Edge       Managed Chromium
 chrome.debugger          WAG profile        isolated context
 nativeMessaging               |                   |
           +-------------------+-------------------+
                               |
                    Browser Semantic Engine
                               |
           snapshot / click / fill / press
           navigate / screenshot / verify
                               |
                       Effect Coordinator
                               |
                per-target claim + fencing epoch
                               |
                    durable effect receipt
```

All three modes share one semantic action model. They may use different transports, but they must not diverge into incompatible interaction engines.

## Mode A — ATTACH_EXISTING

Preferred path for authenticated sessions already open in Edge/Chrome.

### Extension/nativeMessaging-first

The supported design is browser-extension-first:

```text
WAG Local <-> nativeMessaging <-> WAG extension
                               |
                         chrome.debugger
                               |
                      exact existing tab
```

Do not make the default design depend on attaching a remote-debugging port to the user's default profile.

Requirements:

- enumerate eligible windows/tabs without stealing focus;
- attach to an exact target identity;
- preserve the user's existing login state;
- never export cookies, tokens, passwords or raw CDP secrets;
- never expose unrestricted raw CDP passthrough;
- do not close the user's browser when WAG releases ownership;
- target actions by durable logical binding, never foreground focus;
- return structured errors when browser/enterprise policy blocks attach;
- never silently fall back to UIAutomation.

Initial structured errors include:

```text
ATTACH_PERMISSION_REQUIRED
ATTACH_BLOCKED_BY_BROWSER_POLICY
ATTACH_BLOCKED_BY_ENTERPRISE_POLICY
DEBUGGER_ALREADY_ATTACHED
DEBUGGER_DETACHED_BY_USER
TARGET_NOT_FOUND
TARGET_OWNED_BY_OTHER_SESSION
TARGET_FENCED
TARGET_STALE
```

## Mode B — WAG_VISIBLE

Use a WAG-managed visible local browser when observation or human takeover improves reliability:

- first login;
- OAuth;
- complex multi-step forms;
- debugging;
- CAPTCHA/human checkpoints;
- payment/legal review that requires the user.

State model:

```text
RUNNING
PAUSED_FOR_USER
USER_CONTROL
RESUMING
STOPPED
```

Controls:

```text
Pause
Take Control
Resume
Stop
```

Human takeover must be explicit. Resume requires a fresh snapshot and state revalidation.

Do not build cloud video streaming merely to imitate remote browser services; the browser is local.

## Mode C — WAG_HEADLESS

Keep bounded headless execution for:

- public documentation;
- non-authenticated research;
- localhost/dev-server verification;
- smoke/fixture tests;
- metadata extraction;
- public state checks;
- bounded parallel contexts.

Never require desktop focus.

## AUTO selection

```text
authenticated eligible existing tab -> ATTACH_EXISTING
human observation/login/handoff needed -> WAG_VISIBLE
otherwise -> WAG_HEADLESS
```

Explicit mode selection remains available.

## Durable logical identity

The durable identity is `browser_session_id`, not OS/process/tab IDs.

```text
browser_session_id
  -> binding
       adapter
       target_id
       target_generation
       process_id?   ephemeral
       window_id?    ephemeral
       tab_id?       ephemeral
       origin
       execution_mode
       ownership_mode
```

Recovery may replace ephemeral IDs while preserving or explicitly succeeding the logical session.

## Per-target ownership and fencing

Do not reintroduce a global Goal-Lease-style browser blocker.

Each claimed target carries:

```text
owner_session_id
claim_epoch
claimed_at
heartbeat
expires_at
```

Each effect binds:

```text
browser_session_id
target_id
claim_epoch
effect_id
```

A stale session using an old epoch must fail with `TARGET_FENCED`.

Minimum concurrency acceptance:

- Session A can operate tab A;
- Session B can operate tab B;
- neither session can act on the other's tab;
- one tab cannot be silently owned by conflicting sessions;
- stale claims expire/recover safely.

## Framework-safe fill

The public contract is semantic:

```text
fill(target, value)
```

Do not define success merely as a hard-coded event sequence.

The internal engine may use the appropriate native/CDP/extension interaction for:

- plain input;
- textarea;
- React controlled input;
- React Hook Form or equivalent;
- Vue/Svelte/Angular controlled input;
- contenteditable;
- ProseMirror;
- TipTap.

Success is measured by postconditions:

- final visible value/content is correct;
- framework/editor model accepted it;
- validation state updated;
- submit enablement/post-action state is correct;
- rerender did not duplicate or lose text.

No PowerShell/UIAutomation keyboard fallback is allowed for normal supported inputs.

## OAuth / redirects

Support deterministic:

- same-tab redirect;
- new-tab redirect;
- new-window redirect;
- callback to original origin.

`browser_session_id` either remains bound to the logical workflow or returns an explicit successor target. The agent should not have to rediscover the entire browser tree manually.

## Runtime/session recovery

Distinguish:

- browser target died;
- MCP connection died;
- WAG runtime restarted;
- tab still exists;
- WAG-owned profile still exists.

After reconnect:

- recover or explicitly reattach when safe;
- preserve prior exact-once effect receipts;
- never replay a completed click/submit;
- mark unrecoverable targets explicitly.

## Diagnostics privacy

May record:

- sequence;
- opaque browser session/target IDs;
- ownership mode;
- action type;
- duration;
- success/failure;
- error class;
- redirect/target-change/recovery booleans.

Must not store:

- typed passwords;
- page text;
- cookies;
- tokens;
- full sensitive URLs/query strings;
- form content.

## Feasibility spike — before full BrowserBroker implementation

Prove these seven items first:

1. enumerate three existing Edge/Chrome tabs without changing focus;
2. attach to the exact authenticated/fixture tab through extension debugger;
3. snapshot/read a background tab;
4. fill/click a background tab without activating it;
5. keep WAG Local <-> extension nativeMessaging stable;
6. detach while leaving the user's browser open;
7. browser/policy-blocked attach produces structured failure rather than UIAutomation fallback.

If this spike fails materially, stop and revise architecture before implementing the rest.

## Priority

```text
P0  feasibility spike
P0  BrowserBroker + three modes
P0  target ownership + fencing
P0  existing-session discovery/attach
P0  multi-session isolation
P0  framework-safe fill
P1  visible Pause / Take Control / Resume
P1  OAuth/new-target continuity
P1  rich text/contenteditable
P1  runtime/session recovery
P2  sanitized diagnostics/resource bounds
```

## Acceptance harness

Required scenarios:

- existing authenticated-session attach/read/act/release;
- two concurrent sessions with zero cross-target actions;
- React validation: visibly filled input must also update framework state and enable submit;
- TipTap/ProseMirror replacement and model verification;
- OAuth-like same/new-tab/new-window redirect continuity;
- runtime restart/reconnect with no duplicate exact-once external effect;
- attached user browser remains open after release;
- WAG_VISIBLE Pause -> Take Control -> Resume;
- WAG_HEADLESS workflow with no visible browser.

## Final gate

Public `@latest` is blocked until all of these pass:

```text
[ ] Existing BrowserPort regressions PASS
[ ] feasibility spike PASS
[ ] BrowserBroker three-mode architecture PASS
[ ] WAG_HEADLESS PASS
[ ] WAG_VISIBLE PASS
[ ] Pause / Take Control / Resume PASS
[ ] Existing-session discovery PASS
[ ] Attach authenticated existing tab PASS
[ ] Release preserves user browser PASS
[ ] Two-session target isolation + fencing PASS
[ ] React/framework-safe fill PASS
[ ] Standard replacement does not append PASS
[ ] TipTap/ProseMirror PASS
[ ] OAuth redirect continuity PASS
[ ] Runtime recovery PASS
[ ] Exact-once no-duplicate recovery PASS
[ ] Sanitized diagnostics PASS
[ ] No regression to non-browser tools PASS
```

Anything not implemented is reported as `NOT IMPLEMENTED`. Anything not measured is `NOT MEASURED`.

## Success definition

A future ChatGPT session can say:

```text
Use WAG to continue in the Edge tab where I am already logged in.
```

and WAG can select the mode, find/claim the correct target, operate it without foreground dependence, handle modern forms and rich editors, survive OAuth and reconnects, verify the final state, and release cleanly without requiring Desktop Commander, TinyFish or UIAutomation.
