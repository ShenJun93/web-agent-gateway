# Browser Adapter v1 Local Gate Receipt

Date: 2026-09-13
Implementation parent SHA: `1819a07`
Branch: `feat/durable-mutation-control-plane`
Extension id: `nnhhhppkpogkedpjnijeagcbfjaoogec`
Native application name: `com.openai.web_agent_gateway`

## Candidate scope

This milestone replaces the SuperAssistant/proxy transport choreography with a WAG-owned read-only path:

`provider adapter -> MV3 service worker -> Native Messaging -> wag-native-host -> LocalAdapterLink -> WAG`

The browser protocol exposes only `health`, `workspace.open`, and `file.read`. It carries no WAG bearer token, local MCP URL, owner/session/adapter authority, operator credential, mutation approval, raw MCP forwarding, shell, or generic filesystem capability.

The extension uses a stable development public key and exact extension id. The native-host manifest generator emits exactly one `allowed_origins` entry for that id. No private signing key is stored in the repository.

## Local end-to-end evidence

`test/browser-adapter.acceptance.test.ts` creates a fresh disposable Git repository and starts exact-pinned DevSpace against that repository. It then starts the read-only WAG runtime and builds the real Windows SEA native-host executable.

The first native-host process proves `hello -> session.bind -> health -> workspace.open` and returns an opaque `workspace_id`. The process is then closed. A second native-host process connects to the same still-running WAG runtime and proves `file.read` with that same workspace id returns the exact expected file content.

The acceptance test also proves:

- closing a native-host process does not close the WAG runtime;
- the disposable Git fixture remains clean after the complete read-only flow;
- browser/native message evidence does not contain the local MCP URL or bearer token;
- no operator/bootstrap/approval credential appears in the browser/native evidence;
- the absolute repository root is supplied only as the explicit `workspace.open` argument and is not echoed in native-host responses.

Observed acceptance wall time: approximately 24.7 seconds, including native-host SEA build, pinned DevSpace startup/authentication, Git fixture setup, two native-host processes, reads, and cleanup. This is an integration wall time, not a provider/browser latency benchmark.

## Native-host packaging evidence

`test/native-host-artifact.test.ts` builds `wag-native-host.exe` from the current Node 24 runtime using a bundled CommonJS entry and Node SEA injection. The generated SEA configuration sets `execArgvExtension` to `none`.

The produced executable speaks real Chrome Native Messaging framing over stdin/stdout and reaches a local authenticated WAG endpoint. The dedicated artifact rerun passed in approximately 18.1 seconds.

`esbuild@0.28.2` and `postject@1.0.0-alpha.6` are pinned as build-only dependencies. No runtime package was added to the WAG server path.

## Runtime and manifest boundary evidence

The read-only runtime writes a local discovery record containing a random browser-link bearer and loopback MCP URL. The runtime object does not expose the bearer. Closing a `LocalAdapterLink` does not close the WAG runtime, while runtime shutdown removes the discovery file and leaves the externally owned DevSpace process alive.

## ADR-0014 conformance review

The local read-only slice conforms to the five locked control-plane contracts within its current authority. It creates no durable mutation or generic process authority, does not let browser-controlled fields choose WAG owner/session/adapter authority, keeps the native host disposable relative to the WAG runtime, reuses canonical workspace admission/read containment, and projects only the three explicitly allowlisted read-only semantic tools.

Contract 2 is intentionally inactive: Browser Adapter v1 exposes no mutation tool. Contract 4 is exercised only for adapter-process ownership/lifecycle, not as a claim that a generic durable process manager exists.

Contract 3 creates a prerequisite before supported-host installation: Windows namespace/device/alternate-stream forms that are not yet covered by current path-policy tests must be rejected explicitly before `file.read` is projected through the installed browser adapter. Therefore Task 10 installation is blocked on that containment-hardening gate even though Task 9 is read-only.

## Repository verification

Fresh local-gate evidence before this receipt included `test/browser-adapter.acceptance.test.ts` passing with the real SEA executable and exact-pinned DevSpace. The repository gate recorded 115 tests passed, 0 failed, 0 skipped; typecheck and build passed; Business stdio passed 1/1; pinned DevSpace/backend checks passed 8/8; and the dedicated SEA artifact test passed 1/1.

The accepted control-plane contracts remain authoritative over these implementation results. Passing this local gate does not widen filesystem, mutation, terminal, Git, or process authority.

## Gate result

`LOCAL_BROWSER_ADAPTER = PASS`

`REAL_WINDOWS_SEA_NATIVE_HOST = PASS`

`NATIVE_HOST_RECONNECT = PASS`

`DEFAULT_AND_BUSINESS_SURFACES = UNCHANGED`

`SUPPORTED_BROWSER_HOST = NOT_YET_INSTALLED`

`WINDOWS_CONTAINMENT_HARDENING = REQUIRED_BEFORE_TASK_10`

`BROWSER_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

No HKCU Native Messaging registration, browser installation, enterprise policy change, or supported-host browser acceptance is claimed by this receipt.
