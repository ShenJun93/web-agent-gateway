# WAG Browser v2 — STOP 1 BrowserBroker & Managed Modes

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Entering HEAD: `af0bc6659d560541cd20adf328a51b50ea1c7000`

## Result

```text
BROWSER_V2_STOP_1 = PASS
BROWSER_BROKER = IMPLEMENTED
WAG_HEADLESS = PASS
WAG_VISIBLE = PASS
WAG_VISIBLE_TAKEOVER = PASS
ATTACH_EXISTING_RUNTIME_BRIDGE = NOT IMPLEMENTED
AUTO_EXISTING_SESSION_SELECTION = NOT IMPLEMENTED
```

Task 1 introduces one BrowserBroker routing layer while preserving the existing seven-tool BrowserPort MCP surface.

## Architecture

```text
browser.open(mode)
        |
        v
   BrowserBroker
      /     \
     /       \
WAG_HEADLESS  WAG_VISIBLE
     |           |
 BrowserPort  BrowserPort
     \           /
      \         /
  same semantic browser layer
      snapshot / click / fill / press / navigate
```

The existing `ATTACH_EXISTING` extension-debugger feasibility proof remains the selected transport direction, but the production runtime bridge is intentionally not wired in Task 1.

## Mode selection

Current semantics:

```text
undefined / AUTO -> WAG_HEADLESS
WAG_HEADLESS     -> managed dedicated headless Edge
WAG_VISIBLE      -> managed dedicated visible Edge
ATTACH_EXISTING  -> fail closed until Tasks 2-3 runtime bridge lands
```

AUTO remains conservative. Existing-tab discovery and authenticated-state selection are Tasks 2-3 and must not be guessed before the runtime has reliable target inventory.

## Logical session model

Browser sessions now expose bounded mode metadata:

```text
browser_session_id
profile_id
backend
execution_mode
ownership_mode
control_state
process_id? / pid?
state
created_at
last_seen_at
```

The same logical `browser_session_id` remains stable through managed-mode snapshot and close operations.

Durable target identity, target generation and claim epochs are not implemented yet; those belong to existing-target attach/ownership Tasks 2-4.

## WAG_VISIBLE takeover model

Visible managed sessions support:

```text
RUNNING
  -> PAUSED_FOR_USER
  -> USER_CONTROL
  -> RESUMING
  -> RUNNING
```

Pause, Take Control and Resume are published as bounded semantic actions through the existing `browser.exec` tool:

```text
pause_for_user
take_user_control
resume_automation
```

No extra MCP tools were added.

While paused or under user control, normal automated snapshot/exec/screenshot operations fail closed. Resume performs a fresh BrowserPort snapshot before returning to RUNNING.

The three takeover actions remain exact-once effects under the existing durable HarnessEffectCoordinator.

## Managed browser process rules

`WAG_HEADLESS` and `WAG_VISIBLE` share:

- the same BrowserPort abstraction;
- the same semantic interaction engine;
- the same dedicated WAG profile store;
- the same owned Edge CDP backend;
- the same exact process cleanup;
- the same effect tracking.

The visible launch differs only by omitting `--headless=new`.

Task 1 therefore does not create separate incompatible interaction stacks.

## Public MCP surface

Browser opt-in remains exactly:

```text
browser.open
browser.describe
browser.snapshot
browser.exec
browser.effect.get
browser.screenshot
browser.close
```

`browser.open` now accepts:

```text
AUTO
ATTACH_EXISTING
WAG_VISIBLE
WAG_HEADLESS
```

Raw CDP/Playwright implementation tools remain unpublished.

## Real Windows smoke

Real Microsoft Edge smoke:

```text
status = PASS

WAG_HEADLESS
startup_ms = 864.5
snapshot_ms = 42.6
main_edge_process_working_set_kb = 148924

WAG_VISIBLE
startup_ms = 910.3
snapshot_ms = 55.9
main_edge_process_working_set_kb = 153012

visible takeover
pause effect  = SUCCEEDED
take effect   = SUCCEEDED
resume effect = SUCCEEDED
final state   = RUNNING
```

These RAM figures are **main Edge process working set only**. They are not total Chromium process-tree cost and must not be used as final resource limits.

## Verification

```text
focused Task 1 suite = 10 / 10 PASS
BrowserPort/extension regression batch A = 71 / 71 PASS
BrowserPort/private-browser regression batch B = 30 / 30 PASS
real WAG_HEADLESS/WAG_VISIBLE Edge smoke = PASS
typecheck = PASS
build = PASS
git diff --check = PASS
```

The two broad regression batches are non-overlapping file sets, for 101/101 relevant regression tests.

## Known remaining risks

```text
ATTACH_EXISTING runtime native/extension bridge = NOT IMPLEMENTED
authenticated user-profile attach acceptance = NOT EXECUTED
enterprise debugger policy behavior = NOT MEASURED
per-target claim epoch/fencing = NOT IMPLEMENTED
AUTO authenticated-target selection = NOT IMPLEMENTED
OAuth successor-target continuity = NOT IMPLEMENTED
cross-runtime browser-session recovery = NOT IMPLEMENTED
total Edge process-tree RAM = NOT MEASURED
```

## STOP 1 decision

```text
PROCEED_TO_EXISTING_TARGET_DISCOVERY_AND_ATTACH = YES
```

Next work is Tasks 2-3:

1. bounded existing browser/window/tab discovery through the extension/native bridge;
2. native runtime -> extension control protocol;
3. safe attach/release to an exact target;
4. durable logical target binding without foreground focus;
5. prepare per-target fencing for Task 4.
