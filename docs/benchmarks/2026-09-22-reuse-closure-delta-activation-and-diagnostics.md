# WHOLE_WAG_REUSE_CLOSURE — delta for the activation and diagnostics fixes

2026-09-22. Scope: **only** the two blockers the failed live attempt found. Nothing else in the
tree was re-audited; the full closure of 2026-09-21 stands.

```text
NATIVE -> STANDARD -> PROVEN OSS/SERVICE -> COMPOSE -> WRAP -> EXTEND -> BUILD
```

**Verdict: `WHOLE_WAG_REUSE_CLOSURE = PASS` for this delta.** One BUILD-new module, justified
below; everything else is EXTEND over existing code or COMPOSE over an existing WAG surface.

---

## A. Activation correctness — EXTEND, and one reuse improvement

`docs/pending/activate-delegation-control.mjs` was already there; this changes how it writes.

| Concern | Rung | What supplies it |
| --- | --- | --- |
| Atomic config replace | **NATIVE** | `fs.rename` over a sibling temp file. No library, no lock file, no new format. |
| Verifying the result | **COMPOSE** | It now reads the config back through the gateway's own `loadPrivateGatewayConfig` instead of hand-parsing JSON. The check is the parse the gateway will actually do, so a config that satisfies the instrument and fails the gateway is no longer possible. |
| Grant identity checks | **COMPOSE** | `validateDelegationBindings` and `validateBindings` — the policy's own validators, not restated copies. |
| Refusal ordering | **EXTEND** | The already-named-lease check moved into the preconditions, so a refusal mints nothing. |

**No BUILD-new here.** The previous version hand-checked the patched JSON with `JSON.parse` and
its own field comparison; replacing that with the gateway's loader removes a second, subtly
different notion of "is this config valid" — a duplicate this delta deletes rather than adds.

---

## B. Diagnostics — one BUILD-new module, and why nothing higher fits

`browser/extension/delegated-diagnostics-v5.js`, ~40 lines of logic.

| Rung | Considered | Outcome |
| --- | --- | --- |
| **NATIVE** | `console` in the MV3 service worker | **Used.** It is the default sink and the only output path. The module formats a record and hands it to `console.info`; that is the whole transport. |
| **STANDARD** | — | No standard exists for extension-side diagnostics. |
| **PROVEN OSS** | `pino`, `debug`, `loglevel` | Rejected. Any of them adds a bundled dependency to a *shipped browser extension* to replace one `console.info` call, and every one brings formatting, levels and transports this does not want. The cost is a supply-chain surface in the extension; the benefit is nil. |
| **COMPOSE** | An existing extension logging path | **Measured: none existed.** `delegated-observation-v5.js`, `native-session-core-v5.js` and `delegated-dispatch-core-v5.js` contained zero log statements between them. There was nothing to compose. |
| **COMPOSE** | `src/telemetry.ts` | Not reachable and not applicable. It is a gateway-process sink over `GatewayTelemetryEvent` — a per-tool timing record — and the extension is a different runtime that cannot import from `src/`. More decisively: **the failures being diagnosed happen before anything reaches the gateway**, which is exactly why gateway-side telemetry could not see them. |
| **EXTEND** | Add fields to an existing record type | Nothing to extend, per the two rows above. |
| **BUILD** | — | A closed reason set, an allow-list, and a one-line default sink. |

### What is genuinely new, and how little it is

```text
DELEGATED_REASONS   12 reason codes, frozen
safeDetail()        an allow-list of 7 reference-shaped fields
createDelegatedDiagnostics()  formats one record, hands it to console, swallows sink failures
```

Everything else is a call site passing a reason it already knew.

### Not a duplicate of the gateway's denial codes

`DelegationDenialCode` in `goal-ui-delegation.ts` is the **gateway's** refusal vocabulary.
`DELEGATED_REASONS` is the **extension's** decline vocabulary, and they describe different layers:
most of the extension's reasons — no host, dead link, failed handshake, no delegation offered —
have no gateway equivalent because the gateway never saw the attempt. Where a gateway code does
exist, the extension **carries it through** in the record's `code` field rather than restating it.
One vocabulary per layer, and the layers are joined by a field rather than by a copy.

### Allow-list, not deny-list — a convention this repo already holds

`safeDetail` enumerates the fields that may appear rather than the fields that may not. That is the
same shape as `createDelegationDispatchPort`, which builds the browser-reachable port by listing
allowed method names so a method added later is absent until someone adds it deliberately, and as
`verify-runner.ts`, which builds a child environment upward from an allowlist. Reuse of an accepted
convention rather than of code, which is the appropriate kind here.

---

## What was deliberately not touched

Per the mandate: renderer extraction, DevSpace architecture, protocol versioning, generic policy
and sandboxing were not reopened. No accepted effect semantics changed. The diagnostics add no
authority and no control surface — `emit` returns nothing, every call site ignores it, and a test
proves the outcome, the memory writes and the transport calls are identical whether diagnostics are
absent, wired, or throwing on every call.
