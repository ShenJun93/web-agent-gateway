---
name: wag-acceptance-gates
description: Use when running WAG's acceptance gates or writing an acceptance receipt — before claiming any milestone green, or when a gate run is interrupted and must be re-established. Covers the exact gate commands, the environment traps that silently invalidate a run, and the evidence a receipt must carry.
---

# WAG acceptance gates

AGENTS.md defines the authority order and the mission guardrails. This skill is only the mechanical
procedure for producing gate evidence that is actually valid, plus the traps that have silently
invalidated runs before.

## Before the first gate in a worktree

A fresh worktree usually has no `node_modules`, and Node resolves upward, so `tsc` and `tsx` silently
bind to whatever the **main checkout** has installed — which is normally an older commit. A gate run
in that state proves nothing.

```bash
ls node_modules >/dev/null 2>&1 || npm ci
```

`esbuild`'s postinstall is blocked by policy here. That is expected; only the native-host SEA build
needs it.

## The gates

Run in this order. Record the exact command and exit code for each.

```bash
npm test                     # full suite, ~6-9 min serially
npm run typecheck
npm run build
npm run test:business        # the shipped five-tool stdio contract
npm run test:dc-replacement  # production-local: built dist/cli.js + real DevSpace + real operator HTTP
git diff --check
gitleaks detect --source . --log-opts "<base>..<head>" --redact --no-banner
```

### Do not block on the full suite

`npm test` takes minutes. Start it in the background writing to a log, then wait on the log, never on
a bare sleep:

```bash
npm test > "$TEMP/wag-test.log" 2>&1; echo "EXIT=$?" >> "$TEMP/wag-test.log"   # run_in_background
until grep -q "EXIT=" "$TEMP/wag-test.log"; do sleep 10; done
```

### Re-run after the last edit

Node's test runner spawns each file when it reaches it. Editing source while a suite runs produces a
run that mixed two versions of the code. Any suite that started before your final edit is **not**
authoritative — re-run it.

## Environment traps that invalidate a run

- **Pinned DevSpace.** Integration and production-local gates need the pinned upstream checkout at the
  revision in `docs/benchmarks/devspace-pin.json`, at `$DEVSPACE_PIN_DIR` or
  `%TEMP%/web-agent-gateway-devspace-<short-rev>`, already built. `startPinnedDevspace` verifies the
  revision and fails loudly on drift.
- **Orphan processes.** Interrupted runs leave `node.exe` children of this worktree behind, and a
  leaked DevSpace holds its port. Clean up **only** processes whose command line contains this
  worktree path. Other worktrees' orphans belong to other sessions — never broad-kill.
- **A failing integration test can hang the whole suite.** An assertion that throws before its
  cleanup hook leaves a real DevSpace and a real loopback HTTP server alive, and the runner then
  waits on those handles forever. The symptom is a log that stops growing mid-run with one `✖`
  already printed. Fix the test, kill only this worktree's node processes, and re-run — do not
  wait it out.
- **Windows file locks.** SQLite handles must be closed before a temp directory is removed or the
  unlink fails with `EBUSY`. `node:test` runs `t.after` hooks in registration order, so register store
  cleanup before the directory removal.

## Classify a failure before accepting or excluding it

A failing gate is a research trigger, never a reason to lower the target or weaken an assertion.
Classify from live evidence first: missing capability, trust/policy gate, provider or model behaviour,
tool failure, environment prerequisite, protocol contamination, or an external hard constraint. Record
the classification and the evidence. Never delete or relabel a result to get a clean sample.

## What a receipt must carry

Receipts live in `docs/benchmarks/` and follow the house source-receipt format. A receipt is a
point-in-time record for one candidate SHA — do not amend it later; add a successor.

Required:

- exact base SHA and candidate SHA, plus the commits in between;
- host, Node, npm, DevSpace pin revision, and any tool version used for scanning;
- every gate's exact command, counts and exit code — including the ones that only passed with a caveat,
  stated as a caveat;
- for production-local evidence: that the **built** artifact ran as a real child process against the
  real backend, and the exact residue afterwards;
- negative security evidence, not just the happy path;
- an explicit list of what the result does **not** authorize.

Local acceptance never implies push, PR, merge, release, tag, signing, provider actions, or any
Layer B WebChat tier claim. Say so in the receipt.
