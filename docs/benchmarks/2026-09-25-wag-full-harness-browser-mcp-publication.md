# WAG Full Harness — Private BrowserPort MCP Publication

Date: 2026-09-25

## Commit

```text
e0b67699ae4be433d76ebb90e39245085a2dcfb0
feat: publish private BrowserPort MCP surface
```

Base before this slice:

```text
69abe2a3df54071638411531c07d780db110de1e
```

This slice was implemented only in the clean Full Harness integration worktree. No uncommitted
bytes from the active WAG-Core worktree were merged.

## Publication model

The existing private-local MCP surface remains unchanged by default:

```text
43 tools
AUTONOMOUS_LOCAL
```

When the private config explicitly enables `repositoryEngineering.browser`, six additional
BrowserPort tools are published:

```text
browser.open
browser.describe
browser.snapshot
browser.exec
browser.screenshot
browser.close
```

The resulting opt-in surface is:

```text
49 tools
```

No raw CDP or Playwright implementation tool is public.

`browser.exec` accepts only bounded semantic actions:

```text
navigate
click
fill
press
```

and requires an `idempotency_key`. Raw CDP method names and arbitrary host shell execution are
not accepted by its MCP schema.

## Authority and ownership

BrowserPort uses the existing private-stdio caller identity for ownership continuity, but browser
authority is not projected into filesystem, Git, command, or remote-effect authority.

The public browser session view intentionally omits:

```text
ownerId
sessionId
adapterId
```

Owned Edge sessions may report their WAG `processId` and OS PID as observation metadata so live
acceptance can prove exact process lifecycle. Those identifiers are not authority grants.

The browser config is explicit and local:

```text
repositoryEngineering.browser.edgeExecutablePath
repositoryEngineering.browser.profileRoot
```

Both paths must be absolute. Browser publication currently composes with the existing private
repository-engineering identity runtime; config without mutation identity is refused. This is an
assembly dependency, not an implication that browser authority grants FILE_WRITE or LOCAL_COMMAND.

## Effect safety

Browser process allocation remains lazy: runtime start and doctor do not launch Edge or create a
browser profile. Allocation occurs only at `browser.open`.

Every browser mutation is rechecked against the autonomous stop before the effect boundary.

`browser.exec` is wrapped by `HarnessEffectCoordinator` and the durable
`HarnessEffectLedger`:

```text
same idempotency key + same successful plan
=> return durable SUCCEEDED
=> do not dispatch again

uncertain execution
=> OUTCOME_UNKNOWN
=> retry is not claimable
=> no blind replay
```

The effect ledger is stored beside the private mutation state as:

```text
<statePath>.harness-effects.sqlite
```

An executing effect found after restart is reconciled to `OUTCOME_UNKNOWN`.

Read surfaces remain separate:

- semantic snapshots are bounded to 500 nodes with bounded fields;
- screenshots are bounded to 8 MiB and returned as MCP image content;
- browser close remains available for exact owned cleanup.

## Concrete backend

Production BrowserPort composition is:

```text
BrowserPort
  -> owned dedicated profile store
  -> owned Edge launcher
  -> ProcessPort
  -> loopback-only CDP readiness
  -> raw CDP transport internally
  -> semantic DOM/accessibility controller
```

Playwright remains an internal adapter capability, not the architecture and not a public tool.

Desktop, Audio, Sandbox, CredentialBroker and low-level Artifact foundations were deliberately not
published in this slice because the current integration candidate does not yet provide an equally
complete production host backend/public authority path for each of them. Existing
`machine.process.*` remains the public process surface; no duplicate process API was added.

## Verification

Fresh after publication:

```text
npm run typecheck          PASS
npm run build              PASS
git diff HEAD --check      PASS
```

Original Full Harness composite test files:

```text
38 / 38 PASS
38 / 38 PASS
41 / 41 PASS
----------------
117 / 117 PASS
```

Current autonomous-local/core regression batch:

```text
16 / 16 PASS
```

New MCP publication tests:

```text
8 / 8 PASS
```

Total verified source gate:

```text
141 / 141 PASS
0 FAIL
```

The publication tests additionally prove:

- browser opt-in projects 49 tools while default remains 43;
- no public CDP/Playwright implementation tool appears;
- raw CDP actions are rejected by `browser.exec`;
- succeeded semantic effects do not dispatch twice;
- `OUTCOME_UNKNOWN` cannot be blindly replayed;
- config requires absolute browser paths and private identity;
- runtime assembly remains lazy and launches no browser;
- CLI forwards the BrowserPort context to stdio.

## Not claimed yet

This receipt does not claim:

- deployment/runtime promotion;
- a live Edge allocation;
- authenticated Notebook99 control;
- Notebook99 H3 execution;
- browser upload/download publication;
- Desktop/Audio/Sandbox/Credential MCP publication;
- Git push or any other remote Git authority.

## Next gate

Before the first live browser allocation, fresh-read:

```text
E:/AI-BROWSER/PLAYWRIGHT_HANDOFF.md
```

Then perform only the bounded owned-browser acceptance allowed by the current policy:

```text
dedicated profile
owned Edge process
loopback CDP
BrowserPort attach
semantic snapshot
controlled navigation/action
verification/screenshot
close exact target
stop exact process
```

No default Edge profile or daily-driver browser session may be adopted.
