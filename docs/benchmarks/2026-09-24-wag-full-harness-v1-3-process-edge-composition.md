# WAG Full Harness v1.3 — ProcessPort + owned Edge composition source receipt

Date: 2026-09-24
Branch: feat/full-harness-browserport-v1
Parent: b76daa051de91c3051b324f32acd05395e92e300
Status: SOURCE-GREEN / NO LIVE EDGE / NOT MCP-PUBLISHED

## Added

ProcessPort:
- start
- describe
- list
- read
- write
- closeStdin
- wait
- stop

Process ownership is exact owner/session/adapter plus an opaque processId. A foreign authority
cannot inspect or stop another process handle.

Node backend:
- direct argv spawn with shell=false;
- constructed/sanitized environment;
- bounded stdout/stderr capture;
- stdin pipe;
- detached process group semantics;
- exact-owned tree cleanup using taskkill /PID /T /F on Windows and process-group kill elsewhere.

Owned Edge composition:
- pure Edge launch plan remains the only source of authority-sensitive debug/profile flags;
- ProcessPort starts the exact plan;
- bounded CDP readiness gate runs before attach;
- raw CDP backend attaches only after readiness;
- readiness failure reaps the exact process;
- CDP attach failure closes transport and reaps the exact process;
- close tears down both target/transport and the exact owned browser process.

## Failure found and fixed

A focused test proved that a CDP protocol error from Target.attachToTarget could throw before the
raw backend closed its transport. The open path is now transactional: any pre-session error closes
the transport before propagating the failure. The owned Edge composition then reaps the exact
process.

Two file.replace calls reported OUTCOME_UNKNOWN / DivergentTarget while their exact readback showed
the intended bytes present. No blind retry was performed; work continued only from the read-back
SHA/content.

## Measured gates

Process/Edge focused:
```text
12 pass
0 fail
```

Browser + Process + existing autonomous-local/repository regression:
```text
46 pass
0 fail
```

Repository source build:
```text
npm run build
PASS
```

## Non-claims

- no Edge process was launched;
- no existing browser/profile was touched;
- no public ProcessPort or BrowserPort MCP tools exist yet;
- process recovery after WAG crash is not implemented;
- no OS sandbox/network isolation is claimed;
- no Notebook99 action occurred.
