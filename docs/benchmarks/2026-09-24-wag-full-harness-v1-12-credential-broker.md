# WAG Full Harness v1.12 — CredentialBroker foundation

Date: 2026-09-24
Branch: feat/full-harness-credential-broker-v1
Base: e6c76550993ea4f1b6e406fcb3a9816abb78346b
Status: SOURCE-GREEN / HOST-SIDE BROKER CONTRACT / NO REAL CREDENTIAL USED

## Added

src/security-harness/credential-broker.ts

CredentialBroker v1:
- exposes credential descriptors without secret values;
- resolves secret material only after caller policy succeeds;
- exact HTTPS origin allowlist;
- segment-aware path allowlist;
- explicit GET/POST/PUT/PATCH/DELETE method allowlist;
- caller cannot supply Authorization/Cookie/Proxy-Authorization/Host/Content-Length/Connection/
  Transfer-Encoding or the broker-owned injection header;
- request/response byte ceilings;
- auth prefix/header injected only inside the transport request;
- transport is required to use redirect=manual;
- 301/302/303/307/308 are refused rather than replayed;
- 304 remains usable;
- Set-Cookie/Authorization-style response headers cannot be exposed;
- only configured response headers are projected back;
- direct plaintext secret reflection in exposed response headers or response bytes fails closed;
- secret-source and transport exceptions are converted to generic errors;
- every acquired secret lease is released in finally.

## Measured gates

CredentialBroker focused:

```text
9 pass
0 fail
```

CredentialBroker + local-machine + ProcessPort environment-security regression:

```text
15 pass
0 fail
```

Repository source build:

```text
npm run build
PASS
```

## Mutation note

One hardening file.replace returned OUTCOME_UNKNOWN / DivergentTarget. No blind replay occurred.
Exact readback proved both intended changes were present:
- segment-aware path prefix matching;
- explicit redirect-status set that permits HTTP 304.
The focused and combined gates were then rerun on the read-back bytes and passed.

## Security boundary

This slice prevents the normal agent/tool surface from reading the raw credential and narrows where
the broker may inject it.

It does not claim:
- hostile-same-process memory isolation;
- detection of every transformed/encoded/hash-derived reflection of a secret by a malicious upstream;
- TLS interception or certificate pinning;
- OS keychain implementation;
- network microVM isolation;
- OAuth refresh implementation.

Those are later source/backend concerns. Exact plaintext reflection is blocked as defense in depth,
not presented as the primary trust boundary.

## Integration target

A future host egress/sandbox adapter should:
1. enforce network allow/deny independently of credential binding;
2. resolve credentials from a host-side keychain/secret manager;
3. inject only inside the trusted proxy/transport;
4. disable automatic redirect forwarding;
5. preserve this broker's exact caller/origin/method/path constraints;
6. emit receipts containing credential id and policy decision, never secret values.

## Non-claims

- no real API key/token was loaded;
- no external network request was made;
- no secret store/keychain was opened;
- no public MCP tool changed;
- no runtime/config promotion occurred.
