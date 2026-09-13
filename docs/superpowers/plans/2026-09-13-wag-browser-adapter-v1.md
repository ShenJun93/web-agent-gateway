# WAG Browser Adapter v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only ChatGPT Web adapter that reaches the existing WAG control plane through a WAG-owned MV3 extension, Chrome Native Messaging, and a thin native host without exposing local WAG credentials or widening the default/Business tool surfaces.

**Architecture:** The provider page is untrusted. A ChatGPT content adapter reports bounded observed text to an MV3 service worker; the service worker validates sender/origin, parses only the WAG structured-call format, queues calls for extension-owned user execution, and sends allowlisted semantic requests over Native Messaging. `wag-native-host` validates the versioned envelope and uses an internal authenticated `LocalAdapterLink` to the existing WAG HTTP/MCP runtime.

**Tech Stack:** Node.js 22.19–26, TypeScript 6, existing MCP SDK 1.29.0, Zod 4, Manifest V3, Chrome Native Messaging, Chrome Side Panel API, Node SEA for Windows host packaging, esbuild + postject as build-only tooling.

**Spec:** `docs/superpowers/specs/2026-09-13-wag-browser-adapter-v1-design.md`

## Global Constraints

- Browser/native envelope maximum: `256 KiB` serialized UTF-8 JSON.
- First transport milestone exposes only `health`, `workspace.open`, and `file.read`.
- Browser code never receives the WAG loopback URL, bearer token, operator bootstrap URL, or operator credential.
- No browser-side approval operation exists.
- Native host protocol has no shell, generic filesystem, arbitrary URL, raw MCP, or generic proxy operation.
- ChatGPT Web is the only provider in v1; Gemini/Kimi remain follow-ups.
- Stable unpacked extension identity is derived from a committed public manifest key; no private signing key is committed.
- HKCU Native Messaging registration and browser installation are operational acceptance steps requiring separate explicit authorization.
- Default MCP and Business stdio surfaces remain unchanged.

---

### Task 1: Versioned Browser Adapter Protocol

**Files:**
- Create: `src/browser-adapter/protocol.ts`
- Create: `test/browser-adapter-protocol.test.ts`

**Interfaces:**
- Produces: `BROWSER_ADAPTER_PROTOCOL_VERSION = 1`.
- Produces: `BROWSER_ADAPTER_MAX_BYTES = 256 * 1024`.
- Produces: `BrowserToolName = 'health' | 'workspace.open' | 'file.read'`.
- Produces: `BrowserAdapterRequest` union for `hello`, `session.bind`, `session.unbind`, `tools.list`, `tool.call`, and `ping`; tool calls carry a bounded transport `sessionId`.
- Produces: `BrowserAdapterResponse`, `parseBrowserAdapterRequest`, `parseBrowserAdapterResponse`.

- [ ] **Step 1: Write failing protocol tests.** Prove strict version/type parsing, request/session-id bounds, `hello`, one active transport-session binding shape, `ping`, exact tool allowlist, argument schemas, response/error bounds, rejection of extra keys, and rejection when serialized UTF-8 size exceeds `256 KiB`.
- [ ] **Step 2: Run `npx tsx --test test/browser-adapter-protocol.test.ts`; verify RED because the protocol module does not exist.**
- [ ] **Step 3: Implement the protocol with strict Zod discriminated unions.** `health` accepts `{}`; `workspace.open` accepts `{ path: string }`; `file.read` accepts `{ workspace_id: string, path: string }`; responses carry either bounded JSON-safe `result` or bounded `{ code, message }`.
- [ ] **Step 4: Add `serializedBytes(value)` and enforce the same cap on ingress and egress before parsing/returning.**
- [ ] **Step 5: Run the task test plus `npm run typecheck`; verify GREEN.**
- [ ] **Step 6: Commit `feat: define browser adapter protocol`.**

### Task 2: Native Messaging Framing

**Files:**
- Create: `src/browser-adapter/native-framing.ts`
- Create: `test/native-messaging-framing.test.ts`

**Interfaces:**
- Consumes: `BROWSER_ADAPTER_MAX_BYTES` from Task 1.
- Produces: `encodeNativeMessage(value): Buffer` and `NativeMessageDecoder.push(chunk): unknown[]`.

- [ ] **Step 1: Write failing framing tests.** Cover one complete frame, split 4-byte prefix, split body, multiple frames in one chunk, invalid UTF-8/JSON, zero-length frame, oversized length prefix, and no output before a complete body arrives.
- [ ] **Step 2: Run `npx tsx --test test/native-messaging-framing.test.ts`; verify RED.**
- [ ] **Step 3: Implement Chrome Native Messaging framing.** Prefix each UTF-8 JSON body with one unsigned 32-bit little-endian byte length; reject frames above `256 KiB` before allocation/copy beyond the bounded buffer.
- [ ] **Step 4: Ensure parse errors are converted to bounded protocol errors by callers rather than written to stdout as logs.** Native-host stdout is reserved exclusively for framed protocol bytes.
- [ ] **Step 5: Run task tests and typecheck; verify GREEN.**
- [ ] **Step 6: Commit `feat: add native messaging framing`.**

### Task 3: Authenticated LocalAdapterLink

**Files:**
- Create: `src/browser-adapter/local-link.ts`
- Create: `test/local-adapter-link.test.ts`
- Modify: `src/http-server.ts` only if a small exported auth/client seam is required; do not add a browser-facing endpoint.

**Interfaces:**
- Produces: `AdapterDiscovery { mcpUrl: string; bearerToken: string }` loaded from a local-only JSON file.
- Produces: `LocalAdapterLink { listTools(): Promise<readonly BrowserToolName[]>; call(request: BrowserAdapterRequest): Promise<BrowserAdapterResponse>; close(): Promise<void> }`.
- Produces: `McpLocalAdapterLink`, which internally uses the existing MCP Streamable HTTP endpoint but exposes only the three semantic browser tools.

- [ ] **Step 1: Write failing tests using a real `startGatewayHttpServer` with a fake `GatewayApi`.** Prove the link authenticates, filters tool discovery to the three allowlisted names, maps calls/results, rejects unknown tools locally, and redacts transport URLs/tokens from errors.
- [ ] **Step 2: Prove a browser request cannot supply or override bearer token, MCP URL, owner/session/adapter identity, or mutation context.**
- [ ] **Step 3: Run `npx tsx --test test/local-adapter-link.test.ts`; verify RED.**
- [ ] **Step 4: Implement `McpLocalAdapterLink` with the existing SDK client/Streamable HTTP transport.** Read discovery only in native-host process context; never include discovery fields in browser protocol values.
- [ ] **Step 5: Run task tests, `test/http-transport.test.ts`, and typecheck; verify GREEN.**
- [ ] **Step 6: Commit `feat: add local browser adapter link`.**

### Task 4: Thin Native Host Engine and CLI

**Files:**
- Create: `src/browser-adapter/native-host.ts`
- Create: `src/browser-adapter/native-host-main.ts`
- Create: `test/native-host.test.ts`

**Interfaces:**
- Consumes: protocol/framing from Tasks 1–2 and `LocalAdapterLink` from Task 3.
- Produces: `runNativeHost({ input, output, link, expectedOrigin }): Promise<void>` for tests and CLI.
- CLI locates exactly one `chrome-extension://<id>/` caller-origin argument from the native-host invocation, loads discovery from `%LOCALAPPDATA%\WebAgentGateway\browser-adapter.json` by default, and supports `--discovery <absolute-path>` only for tests/manual disposable runs. It does not hard-code one argv index because source-run Node and packaged SEA argv layouts differ.

- [ ] **Step 1: Write failing engine tests** with `PassThrough` streams and a fake link. Prove exact extension-origin check, `hello`, `session.bind`, tool listing, one tool call bound to that session, `ping`, `session.unbind`, request/response correlation, duplicate request rejection within one host process, malformed frame fail-closed, and no stdout logging outside framed messages.
- [ ] **Step 2: Add lifecycle tests** proving EOF/disconnect closes only the `LocalAdapterLink`; it does not kill the WAG HTTP runtime or any executor process.
- [ ] **Step 3: Run `npx tsx --test test/native-host.test.ts`; verify RED.**
- [ ] **Step 4: Implement the native-host engine.** Validate every decoded request with `parseBrowserAdapterRequest`; validate every response before encoding; send bounded protocol errors for request-scoped failures and terminate on framing/origin violations.
- [ ] **Step 5: Implement the CLI wrapper with stderr-only diagnostics.** Reject relative discovery paths supplied via `--discovery`; never print discovery contents or bearer tokens.
- [ ] **Step 6: Run native-host/protocol/framing tests and typecheck; verify GREEN.**
- [ ] **Step 7: Commit `feat: add thin browser native host`.**

### Task 5: Stable MV3 Extension Identity and Service-Worker Core

**Files:**
- Create: `browser/extension/manifest.json`
- Create: `browser/extension/service-worker.js`
- Create: `browser/extension/service-worker-core.js`
- Create: `browser/extension/sidepanel.html`
- Create: `browser/extension/sidepanel.js`
- Create: `test/browser-extension-core.test.ts`

**Interfaces:**
- Manifest permissions: `nativeMessaging`, `sidePanel`, `storage`; host access only `https://chatgpt.com/*`; no `externally_connectable` web-page bridge.
- Service worker connects only to native application name `com.openai.web_agent_gateway`.
- `service-worker-core.js` exports pure validators/state transitions for Node tests; Chrome API wiring stays in `service-worker.js`.

- [ ] **Step 1: Write failing extension-core tests.** Feed already-parsed `BrowserAdapterRequest` values into the core and prove only `https://chatgpt.com` senders with a real tab id can queue them; pending requests are deduplicated; only side-panel messages may execute a queued request; native responses correlate to the originating tab/request. Raw provider-text parsing is added in Task 6, not duplicated here.
- [ ] **Step 2: Add a manifest test** that asserts MV3, minimum Chrome `114`, exact ChatGPT host permission, `nativeMessaging`, side panel, absence of wildcard host permissions and absence of `externally_connectable` page matches.
- [ ] **Step 3: Create one development RSA public key for the manifest `key` field and discard the private key without writing it to the repository.** Add a test that derives the Chrome extension id from the committed public key and snapshots that id so future accidental identity changes fail CI.
- [ ] **Step 4: Implement the pure service-worker core.** State includes supported tabs, queued read-only requests, one native-port status, and request correlation only; no durable WAG state is copied into extension storage.
- [ ] **Step 5: Implement the initial `service-worker.js`.** Wire side-panel/native-port events to the pure core and establish `chrome.runtime.connectNative('com.openai.web_agent_gateway')`; reconnect only on a later explicit extension/provider event, never in an unbounded retry loop. Task 6 adds raw ChatGPT content-message parsing and sender validation.
- [ ] **Step 6: Implement a minimal extension-owned side panel.** Show connection state, provider/tab, pending semantic call name plus bounded arguments, and `Run`/`Dismiss`; never show WAG bearer/discovery/operator credentials.
- [ ] **Step 7: Run extension-core tests and typecheck; verify GREEN.**
- [ ] **Step 8: Commit `feat: add mv3 browser adapter core`.**

### Task 6: ChatGPT Provider Adapter

**Files:**
- Create: `browser/extension/content/chatgpt.js`
- Create: `browser/extension/chatgpt-call-parser.js`
- Create: `browser/extension/chatgpt-call-parser.d.ts`
- Create: `test/fixtures/chatgpt-tool-call.txt`
- Create: `test/chatgpt-provider.test.ts`

**Interfaces:**
- Produces: `parseChatGptToolCall(text): ParsedProviderCall | undefined` for the exact WAG JSON function-call format.
- Content script sends only bounded `{ type: 'provider.observed_text', text, conversationHint }` messages; it never sends native messages directly.

- [ ] **Step 1: Write failing parser tests** from saved assistant-text fixtures. Accept one complete structured call for `health`, `workspace.open`, or `file.read`; reject incomplete blocks, duplicate parameters, unknown tools, malformed JSON, nested/oversized values, and calls mixed with conflicting tool names.
- [ ] **Step 2: Run `npx tsx --test test/chatgpt-provider.test.ts`; verify RED.**
- [ ] **Step 3: Implement the parser as a pure browser ESM module inside the extension package.** Node tests import this exact runtime module and cross-check each accepted call by constructing trusted request/session ids and passing the resulting envelope through Task 1 `parseBrowserAdapterRequest`; the native host remains the authoritative protocol validator.
- [ ] **Step 4: Implement the content script as a bounded observer.** Inspect only ChatGPT assistant-message containers, forward newly observed text once per DOM node/version, cap each observation below the protocol limit, and derive only a non-authoritative conversation hint from the page URL.
- [ ] **Step 5: Wire ChatGPT observations into `service-worker.js`.** Validate `MessageSender.url` and `sender.tab.id`, parse observed text with `parseChatGptToolCall`, then queue only a validated read-only request in the extension core.
- [ ] **Step 6: Keep v1 result delivery extension-owned.** The side panel renders the bounded tool result for the user; v1 does not auto-submit text into the ChatGPT composer. Chaining `workspace.open -> file.read` in acceptance may use an explicit user relay of the returned opaque workspace id.
- [ ] **Step 7: Run provider, extension-core, and protocol tests; verify GREEN.**
- [ ] **Step 8: Commit `feat: add chatgpt browser provider adapter`.**

### Task 7: Native Host Windows SEA Artifact

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/build-native-host.ts`
- Create: `browser/native-host/sea-config.json`
- Create: `test/native-host-artifact.test.ts`
- Add to `.gitignore`: generated `artifacts/browser-adapter/` contents.

**Interfaces:**
- Produces disposable build output `artifacts/browser-adapter/wag-native-host.exe`.
- Build-only dependencies: `esbuild` bundles the native-host entry to one CommonJS file; `postject` injects a Node SEA blob into a copy of the current Windows `node.exe`.

- [ ] **Step 1: Write a failing artifact test** that invokes the build script in a temp/output directory, starts the resulting `.exe` with a disposable `--discovery` path and expected extension origin, sends one framed `hello`/tool-list exchange, and verifies framed stdout plus stderr-only diagnostics.
- [ ] **Step 2: Add pinned `esbuild` and `postject` devDependencies; update the lockfile.** No runtime dependency is added to WAG.
- [ ] **Step 3: Implement `build-native-host.ts`.** Bundle `native-host-main.ts` for Node CJS, generate the SEA preparation blob with the current Node executable, copy `process.execPath`, inject `NODE_SEA_BLOB`, and fail if host platform is not Windows for this v1 artifact.
- [ ] **Step 4: Set SEA `execArgvExtension` to `none`** so environment/CLI Node options cannot silently extend the embedded runtime configuration.
- [ ] **Step 5: Run artifact test, native-host tests, typecheck and build; verify GREEN.**
- [ ] **Step 6: Commit `build: package browser native host`.**

### Task 8: Read-Only Browser Runtime and Native-Host Manifest Generation

**Files:**
- Create: `scripts/browser-adapter-runtime.ts`
- Create: `scripts/generate-native-host-manifest.ts`
- Create: `src/browser-adapter/native-host-manifest.ts`
- Create: `test/browser-adapter-runtime.test.ts`
- Create: `test/native-host-manifest.test.ts`

**Interfaces:**
- Produces: `startBrowserAdapterRuntime({ configPath, discoveryPath, env })` returning `{ mcpUrl, close() }` and writing a local-only discovery JSON containing the loopback MCP URL plus a random bearer token. No read-only-only state database is introduced; reconnect relies on the still-running WAG runtime.
- Produces: `createNativeHostManifest({ executablePath, extensionId })` with name `com.openai.web_agent_gateway`, `type: 'stdio'`, and exactly one `allowed_origins` entry `chrome-extension://<extensionId>/`.

- [ ] **Step 1: Write failing runtime tests** with exact-pinned DevSpace. Prove the runtime binds authenticated loopback only, writes discovery outside the fixture repository, consumes the DevSpace owner token from the supplied environment, keeps the generated browser-link bearer only in local discovery state, and closing a native-host/link client does not close the runtime.
- [ ] **Step 2: Write failing native-host manifest tests.** Reject relative executable paths, malformed or wildcard extension ids, and non-Windows path forms for the v1 generator; prove output contains exactly one allowed origin.
- [ ] **Step 3: Run both test files; verify RED.**
- [ ] **Step 4: Implement the read-only assembly** from `bootstrapPrivateGateway` + `startGatewayHttpServer`; do not pass `mutationContext` or `enableFilePatch`.
- [ ] **Step 5: Implement manifest generation and a dry-run CLI output under `artifacts/browser-adapter/`.** The CLI writes only artifact files; it does not touch HKCU, Chrome/Edge policies, or installed extension state.
- [ ] **Step 6: Run runtime/manifest tests, private-runtime/http regression tests, typecheck and build; verify GREEN.**
- [ ] **Step 7: Commit `feat: assemble read-only browser adapter runtime`.**

### Task 9: Local End-to-End Adapter Gate Without Browser Installation

**Files:**
- Create: `test/browser-adapter.acceptance.test.ts`
- Create: `docs/benchmarks/2026-09-13-browser-adapter-v1.md`

- [ ] **Step 1: Write an acceptance test** using a fresh disposable Git fixture, exact-pinned DevSpace, the read-only browser runtime, the packaged native-host executable, and framed Native Messaging input/output.
- [ ] **Step 2: Prove `health -> workspace.open -> file.read` end to end** through `wag-native-host.exe`, including exact expected file content and opaque workspace id.
- [ ] **Step 3: Close the native-host process, start a second native-host process against the same still-running WAG runtime, and prove the same `workspace_id` remains readable.**
- [ ] **Step 4: Prove browser/native messages and errors never contain the MCP URL, bearer token, local operator credential, or repository-absolute root except the explicit path supplied to `workspace.open` itself.**
- [ ] **Step 5: Run full repository gate:** `npm test`, `npm run typecheck`, `npm run build`, `npm run test:business`, pinned DevSpace checks, native-host artifact test, `git diff --check`.
- [ ] **Step 6: Record local adapter evidence and clearly mark `SUPPORTED_BROWSER_HOST = NOT_YET_INSTALLED`.**
- [ ] **Step 7: Commit `bench: verify browser adapter local path`.**

### Task 10: Supported ChatGPT Host Gate

**Files:**
- Modify receipt after evidence: `docs/benchmarks/2026-09-13-browser-adapter-v1.md`.

- [ ] **Step 1: Stop at the operational setup gate and obtain separate explicit authorization before changing per-user browser/native-host installation state.** Code/spec approval is not installation approval.
- [ ] **Step 2: After authorization, fresh-read the browser automation policy, preflight live sessions, and allocate only an owned disposable session/profile.**
- [ ] **Step 3: Activate only the generated WAG native-host/extension artifacts in that disposable environment and verify the loaded extension identity matches the committed identity snapshot.**
- [ ] **Step 4: Run supported-host read-only acceptance:** ChatGPT produces a valid WAG structured call; the extension queues it; extension-owned UI executes it; Native Messaging reaches WAG; `workspace.open` and `file.read` return expected values. No SuperAssistant or browser-to-local proxy participates.
- [ ] **Step 5: Reconnect only the owned browser adapter session and prove the still-running WAG runtime accepts a new native-host connection and can read the same workspace id.**
- [ ] **Step 6: If browser-control safety blocks any action, stop fail-closed and record the exact blocker.** A direct MCP/native shortcut cannot substitute for supported-host evidence.
- [ ] **Step 7: Clean up only exact resources created for this acceptance run under the authorization granted for that run.**
- [ ] **Step 8: Record `SUPPORTED_BROWSER_HOST = PASS` only after the complete path succeeds; otherwise record a bounded fail-closed status and leave later mutation enablement closed.**
- [ ] **Step 9: Commit the supported-host receipt.**

## Plan Self-Review

- Spec coverage: Tasks 1–10 cover protocol, Native Messaging framing, private local link, thin native host, stable MV3 identity, extension-owned UI, ChatGPT provider parsing, Windows native-host artifact, local end-to-end gate, reconnect semantics and the separate supported-host gate.
- Intentional deferrals: WebMCP implementation, Gemini/Kimi adapters, automatic ChatGPT result submission, durable mutation browser tools, generic job/PTY/Git mutation, named-pipe replacement, production Business mutation and historical `file.patch` cleanup.
- Dependency rationale: `esbuild` and `postject` are build-only for the Windows SEA artifact; runtime dependencies remain unchanged.
- Authority check: no task before Task 10 changes browser/native-host installation state or grants browser code local approval authority.
- Acceptance rule: local framed/native-host tests cannot substitute for the separately authorized supported-host gate.