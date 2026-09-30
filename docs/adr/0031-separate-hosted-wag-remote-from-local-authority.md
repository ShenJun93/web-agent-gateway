# ADR-0031 — Separate hosted WAG Remote identity/routing from local WAG authority

Date: 2026-09-30  
Status: Accepted — M7 remote architecture gate  
Updates: ADR-0018 product boundary  
Depends on: ADR-0014, ADR-0015, ADR-0018, ADR-0019, ADR-0020, ADR-0030  
Research: `docs/research/2026-09-20-ai-native-browser-research-pass-9.md`, `pass-10.md`, `pass-11.md`

## Context

ADR-0018 explicitly made generic remote administration and multi-device brokering non-goals. That was
the correct boundary while WAG's local product, recovery, installation, doctor, lifecycle and
Desktop Commander replacement surface were unproven.

M0-M6 now provide a bounded local product path and measured local capability gaps. The commercial
roadmap therefore reaches the explicit M7 decision gate:

> decide whether and how WAG can add a hosted remote/multi-device product without silently turning
> transport reachability into local machine authority.

WAG already contains an experimental single-device remote relay with bounded encrypted framing,
replay rejection, durable call recovery and an outbound Supabase transport. That implementation is
useful evidence, but its shared device secret and transport-specific identity are **not** accepted as
the production hosted identity/control-plane design.

Research passes 9-11 also establish a stronger standards direction:

- standard MCP Streamable HTTP and OAuth at the hosted client boundary;
- OAuth/OIDC identity rather than a proprietary WAG login protocol;
- OAuth Device Authorization style enrollment for devices;
- standard machine authentication (prefer asymmetric client authentication) after enrollment;
- transport identity is never WAG effect authority;
- no new WAG-specific OAuth, DPoP, delegation or capability-token standard;
- exact local proposal/effect ownership and reconciliation remain WAG-owned.

This ADR updates ADR-0018 only for a separately bounded **WAG Remote** product profile. WAG Local
remains local-first and does not become a generic remote workstation.

## Decision summary

WAG will have two separable product planes:

```text
WAG LOCAL
  local/private MCP
  local machine capabilities
  local authority/effect core
  local lifecycle
  no WAG-hosted account required

WAG REMOTE
  standard hosted MCP + OAuth ingress
  hosted account/device directory
  explicit device routing
  outbound device transport
  local WAG authority/effect core remains authoritative
```

The hosted plane owns identity, reachability, routing and hosted usage accounting.

The local plane continues to own:

- workspace/resource ownership;
- capability/risk reduction;
- exact effect proposal ownership;
- local approval where required;
- durable effect creation;
- execution;
- result/effect reconciliation;
- `CONFIRMED / FAILED / UNKNOWN` truth.

A hosted account, OAuth token, device session, tunnel id, heartbeat, provider confirmation or paid
subscription can never directly grant a local consequential effect.

## 1. Account identity

Hosted WAG Remote accounts are authenticated with standard OAuth/OIDC identity.

Canonical external identity is the verified tuple:

```text
issuer
subject
tenant/organization context when present
oauth client id
resource
granted scopes
optional enterprise/workload context
```

WAG assigns an opaque internal `account_id`. Email address, display name, provider client metadata,
MCP `clientInfo`, connection identity and tunnel identity are not stable authority identifiers.

Enterprise Managed Authorization / Cross-App Access may be composed later for enterprise SSO and
offboarding. It is not per-effect approval.

Provider-specific account adapters are thin normalizers. Core device, routing and local capability
semantics must not depend on ChatGPT/OpenAI-specific identifiers.

## 2. Device identity

Every paired device receives a WAG-hosted opaque `device_id` owned by exactly one account/tenant.

Every device also has an independent asymmetric device credential:

```text
device_id
oauth client_id
device public-key thumbprint
credential generation
enrollment time
revocation state/epoch
human label
last accepted agent version/catalog
```

The device private key is generated locally and must not be uploaded to the hosted service.

Production preference:

1. OS/non-exportable key storage when practical;
2. otherwise an encrypted per-user local credential store with explicit migration/recovery;
3. never one shared long-lived secret across multiple devices.

After enrollment, device-to-host authentication should use standard asymmetric OAuth client
authentication such as `private_key_jwt` where the selected authorization stack supports it.
Sender-constrained access tokens may be evaluated on transports where standards support is proven.

**DPoP is not accepted on the OpenAI Secure MCP Tunnel lane until explicit end-to-end URI/proxy
compatibility exists.**

## 3. Pairing flow

The preferred WAG Remote pairing UX is an OAuth Device Authorization style flow.

```text
local WAG device
  -> generate local device key
  -> request bounded enrollment transaction
  <- device_code + short user_code + verification URI

independent user browser/native auth surface
  -> authenticate WAG account
  -> show device label + enrollment context
  -> approve exactly one enrollment

hosted control plane
  -> consume enrollment transaction once
  -> bind account_id + device_id + device public key
  -> provision device OAuth client identity / short-lived bootstrap result

local device
  -> poll bounded transaction
  -> receive no human account password/token
  -> switch to device-scoped machine authentication
```

The short code is a user convenience, not a bearer capability and not an authorization token.

Enrollment transactions are:

- short-lived;
- single-use;
- account-bound after approval;
- device-public-key-bound;
- replay rejected;
- rate limited;
- auditable by opaque enrollment id.

Chat/model context must never carry persistent account or device credentials.

## 4. Device revocation and recovery

Device revoke is a hosted account action.

Revocation:

- marks the device revoked and increments its credential/revocation generation;
- refuses new device sessions/tokens;
- invalidates future routing;
- terminates or expires hosted transport state;
- does not delete local user data or repositories;
- does not rewrite local WAG authority state.

If revocation occurs before a call is dispatched locally, the call fails as
`DEVICE_REVOKED`.

If revocation occurs after local dispatch and the local effect outcome is not yet reconciled, the
hosted call becomes `UNKNOWN / DEVICE_REVOKED_MID_CALL`. It is **not** retried on another device.

Recovery from device loss requires fresh enrollment. A lost/revoked device credential is never
silently recreated with the old identity.

## 5. Hosted relay trust boundary

Hosted WAG Remote is trusted for:

- account authentication;
- device directory;
- route authorization;
- transport termination/brokering;
- correlation/idempotency records;
- coarse usage accounting;
- health stage aggregation.

Hosted WAG Remote is **not** trusted to mint local effect authority.

For the paid hosted product, MCP requests/results can transit WAG's hosted service. The product must
state that data-path fact explicitly. "Private device" means no inbound device listener is required;
it does not mean hosted payload bytes never transit WAG infrastructure.

The existing experimental Supabase relay is retained only as a transport/prototype donor. Its
shared-secret identity is not the production account/device identity contract.

OpenAI Secure MCP Tunnel remains a separate provider-native reachability lane for WAG Local. It is
not the WAG Remote multi-device control plane and its tunnel id is not a WAG device capability.

## 6. Transport protocol

Client-facing remote protocol:

```text
MCP Streamable HTTP
+ standard MCP OAuth/protected-resource metadata
+ HTTPS/TLS
```

Device-facing transport:

```text
outbound-only TLS transport
+ standard device OAuth access token
+ versioned WAG-internal message envelope
```

The first hosted implementation may use WebSocket, long-poll/SSE, or a managed relay transport, but
the device transport sits behind a replaceable `RemoteDeviceTransport` contract.

Transport selection cannot change:

- account/device ownership;
- request correlation;
- routing authorization;
- local capability semantics;
- effect truth.

No public WAG-specific authentication protocol is created.

## 7. End-to-end request/effect correlation

The hosted edge mints one opaque `request_id` for every accepted remote MCP call.

The same immutable id follows the request through:

```text
hosted MCP ingress
  -> account/device routing
  -> device transport
  -> local WAG call ledger
  -> local effect_id when an effect exists
  -> result/reconciliation
  -> hosted response/audit
```

Separate ids remain separate:

- `request_id` = end-to-end remote request correlation;
- `effect_id` = local durable effect truth;
- transport message/frame ids = delivery mechanics only;
- provider request ids = evidence only, never WAG authority.

Every failure response exposes the stable opaque `request_id` and the failed health/stage class.

## 8. Replay / duplicate suppression

Duplicate suppression exists at both hosted ingress and local device execution.

Rules:

1. same `request_id` + same account/device returns the existing call state/result;
2. same `request_id` with a different account/device is rejected;
3. provider retry never creates a second local execution;
4. duplicate transport delivery never creates a second local execution;
5. completed results may be replayed from bounded durable storage;
6. an executing/unknown effect is never blindly reissued.

The local durable call/effect ledger remains the final execution authority.

## 9. Exactly-once semantics

WAG does **not** claim universal exactly-once remote effects.

Accepted semantics:

- exactly-once **admission/claim** for a given request/effect id where durable CAS supports it;
- at-most-once dispatch from the call ledger;
- idempotent/CAS local operations may reconcile to a confirmed outcome;
- non-idempotent operations that lose outcome certainty become `UNKNOWN`;
- `UNKNOWN` is not auto-retried.

Marketing/product language must use "duplicate-suppressed, durable effect reconciliation" rather
than an unqualified exactly-once claim.

## 10. Offline / reconnect

Device transport reconnects with bounded exponential backoff and a new session generation.

A presence/heartbeat alone never means Ready.

Default remote-call behavior when the selected device is offline:

- do not silently route to another device;
- do not queue consequential effects indefinitely;
- return a stable `DEVICE_OFFLINE` stage/status and the request correlation id.

A future explicit bounded queue may be added for clearly idempotent/read-only workflows, but it is
not authorized by this ADR.

After reconnect:

- the device reauthenticates;
- session generation changes;
- hosted routing revalidates revocation and account ownership;
- durable prior call/effect records remain recoverable by `request_id`;
- no lost request is automatically re-executed merely because transport recovered.

## 11. Multi-device routing

Routing is explicit and account-scoped.

Rules:

- every remote call targets one opaque `device_id`;
- a client can enumerate only devices visible to its authenticated account/tenant;
- with multiple eligible devices, no implicit "last active", hostname guess or broadcast is allowed;
- device labels are display data only; routing uses opaque ids;
- wrong-account/wrong-device requests fail before device transport;
- a device cannot claim another device's route because device OAuth identity/key and route record
  must match;
- revocation is checked again immediately before dispatch.

Cross-device failover is not permitted for an already accepted consequential call.

## 12. Provider neutrality

Core hosted contracts are provider-independent.

Provider adapters may normalize:

- issuer/subject;
- OAuth client/resource/scope facts;
- provider request correlation;
- transport metadata.

They may not redefine:

- device identity;
- device routing;
- local workspace ownership;
- capability/risk policy;
- approval;
- effect semantics.

ChatGPT/OpenAI remains the reference provider. A WAG Remote account/device must remain usable from
another standards-compliant MCP provider without changing local WAG authority semantics.

## 13. Health model

Remote readiness is explicitly layered:

```text
ACCOUNT_AUTH
HOSTED_RELAY
DEVICE_SESSION
DEVICE_TRANSPORT
LOCAL_EXECUTOR
TOOL_ROUNDTRIP
```

Each layer reports a state and timestamp/correlation evidence.

`REMOTE_READY=true` requires all six layers Ready for the selected account/device.

Examples:

- OAuth valid + heartbeat alive + executor dead => **not Ready**;
- relay reachable + device session absent => **not Ready**;
- device connected + local MCP probe failing => **not Ready**;
- all layers Ready + last tool probe succeeded => Ready.

This rule is normative for product UI, APIs and support diagnostics.

## 14. Usage/accounting boundary

Local execution details remain private by default.

Hosted usage accounting may retain only bounded metadata needed for:

- account plan enforcement;
- device-slot enforcement;
- request counts;
- tool-family counts;
- coarse request/response byte counts;
- relay/session time;
- latency;
- success/failure/stage class;
- support correlation.

Hosted usage accounting must not require retaining:

- file contents;
- command text;
- tool arguments;
- tool result bodies;
- credentials/secrets.

A separate explicit support/debug opt-in is required before collecting richer payload diagnostics.

## 15. Free/local versus paid hosted boundary

### Free/local WAG

Remains usable without a WAG-hosted account for:

- local installation/lifecycle;
- local/private MCP;
- direct local WebChat/provider connector paths;
- local tools and authority/effect core;
- local doctor/recovery;
- provider-native private transport such as Secure MCP Tunnel when the user's provider plan supports it.

### Paid hosted WAG Remote

The commercial hosted value boundary is:

- WAG account identity;
- device pairing/directory;
- device revoke/recovery;
- hosted MCP endpoint;
- provider-neutral remote reachability;
- multi-device routing;
- remote readiness/health;
- hosted durable request correlation;
- hosted usage/accounting/support plane.

Exact pricing is not locked by this ADR.

Local tool execution itself is not artificially crippled to force subscription.

## 16. Relationship to ADR-0018

ADR-0018 remains normative for WAG Local.

This ADR changes one explicit non-goal:

```text
ADR-0018 generic remote administration / multi-device brokering:
  remains forbidden as an implicit extension of WAG Local

WAG Remote:
  permitted only as the separately authenticated, explicitly device-routed,
  hosted profile defined here
```

This does not authorize a generic remote desktop/workstation product or unrestricted remote shell.

Every remotely exposed tool remains a WAG semantic capability already accepted by its own local
authority/effect contracts.

## 17. Prototype boundary

M7 prototype must be local/in-memory and transport-independent.

It must prove:

- one-time enrollment-grant consumption;
- device-key binding;
- account-scoped device routing;
- revoke-before-dispatch;
- revoke-mid-call -> UNKNOWN/no retry;
- duplicate/provider retry suppression;
- reconnect/session-generation behavior;
- wrong-device routing refusal;
- concurrent independent request ids;
- layered health requiring all six stages;
- stable request correlation across every failure.

It must **not**:

- create a cloud account/project;
- spend money;
- deploy public infrastructure;
- provision OAuth clients against a real provider;
- replace the current live WAG transport;
- start a new remote relay service;
- promote the experimental Supabase shared-secret lane to production.

## 18. M7 production gates after prototype

Before a hosted beta can be called production-ready:

1. choose an OAuth/OIDC authorization stack supporting Device Authorization and asymmetric device
   client authentication;
2. choose/implement the replaceable device transport;
3. add persistent hosted account/device/request stores;
4. implement revoke/token invalidation against the real authorization stack;
5. run the mandatory failure matrix:
   - connector access-token expiry/refresh;
   - relay delivery loss;
   - device transport reconnect;
   - executor child crash;
   - local agent restart;
   - duplicate delivery;
   - delayed response;
   - provider retry;
   - concurrent calls;
   - device revoked mid-call;
   - wrong-device routing attempt;
6. run a second-provider MCP conformance workflow;
7. document hosted data path and privacy/retention;
8. keep DPoP on Secure MCP Tunnel disabled until explicit compatibility evidence exists.

## Decision markers

```text
ADR_0018_LOCAL_BOUNDARY = RETAINED
WAG_REMOTE_SEPARATE_PRODUCT_PROFILE = ACCEPTED

CUSTOM_REMOTE_OAUTH_PROTOCOL = NO
CUSTOM_PUBLIC_AUTH_STANDARD = NO
MCP_STREAMABLE_HTTP_OAUTH = HOSTED_CLIENT_BOUNDARY
OAUTH_DEVICE_AUTHORIZATION = PREFERRED_PAIRING
ASYMMETRIC_PER_DEVICE_CREDENTIAL = REQUIRED
SHARED_MULTI_DEVICE_SECRET = FORBIDDEN

HOSTED_RELAY = IDENTITY_ROUTING_TRANSPORT_ACCOUNTING
HOSTED_RELAY_AS_LOCAL_EFFECT_AUTHORITY = FORBIDDEN

REQUEST_ID = END_TO_END_CORRELATION
EFFECT_ID = LOCAL_EFFECT_TRUTH
PROVIDER_REQUEST_ID = EVIDENCE_ONLY

DUPLICATE_SUPPRESSION = HOSTED_PLUS_LOCAL
UNIVERSAL_EXACTLY_ONCE_CLAIM = FORBIDDEN
UNKNOWN_EFFECT_AUTO_RETRY = FORBIDDEN

OFFLINE_IMPLICIT_QUEUE = NO
CROSS_DEVICE_FAILOVER_FOR_ACCEPTED_EFFECT = NO
MULTI_DEVICE_ROUTING = EXPLICIT_DEVICE_ID

REMOTE_READY_LAYERS = ACCOUNT_AUTH+HOSTED_RELAY+DEVICE_SESSION+DEVICE_TRANSPORT+LOCAL_EXECUTOR+TOOL_ROUNDTRIP

WAG_LOCAL = FREE_LOCAL_FIRST
WAG_REMOTE = PAID_HOSTED_VALUE_BOUNDARY
LOCAL_TOOL_AUTHORITY_PAYWALL = NO

DPoP_SECURE_MCP_TUNNEL = BLOCKED_WITHOUT_PROVIDER_EVIDENCE
EXPERIMENTAL_SUPABASE_RELAY = PROTOTYPE_DONOR_ONLY

NEXT_GATE = M7_LOCAL_CONTROL_PLANE_PROTOTYPE
```
