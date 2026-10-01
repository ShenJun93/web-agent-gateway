# WAG Remote M7 — Architecture Gate and Local Control-Plane Prototype

Date: 2026-09-30  
Branch: `feat/wag-local-m7-remote-architecture-gate-v1`  
Base: `70a3d0fe7f2a9f079691b9d18d5549764d598032`

## Verdict

`M7_REMOTE_ARCHITECTURE_GATE = PASS`

`M7_LOCAL_CONTROL_PLANE_PROTOTYPE = PASS`

`HOSTED_WAG_REMOTE = NOT_IMPLEMENTED`

`REAL_OAUTH_DEVICE_FLOW = NOT_EXECUTED`

`PUBLIC_INFRASTRUCTURE_DEPLOYED = NO`

M7 makes the remote/multi-device decision without widening the live local WAG runtime or creating a
cloud dependency.

## Accepted architecture

Normative decision:

`docs/adr/0031-separate-hosted-wag-remote-from-local-authority.md`

The ADR explicitly updates ADR-0018 for a separately bounded WAG Remote profile.

Key decisions:

- WAG Local remains usable without a WAG-hosted account;
- WAG Remote is a separate hosted identity/routing/reachability product plane;
- hosted ingress uses standard MCP Streamable HTTP + OAuth;
- pairing uses an OAuth Device Authorization style flow;
- every device has an independent asymmetric credential;
- shared multi-device secrets are forbidden;
- device routing is explicit by opaque device id;
- hosted account/transport identity never becomes local effect authority;
- one end-to-end request id follows ingress -> routing -> device -> local effect/result;
- local `effect_id` remains the final consequential-effect truth;
- duplicate/provider retry suppression exists at hosted and local layers;
- universal exactly-once claims are forbidden;
- unknown effects are never blindly retried;
- offline calls are not silently routed/queued to another device;
- DPoP over OpenAI Secure MCP Tunnel remains blocked until compatibility is explicit;
- the existing Supabase/shared-secret relay remains prototype evidence only.

## Remote readiness contract

A remote device is Ready only when all six layers are Ready:

```text
ACCOUNT_AUTH
HOSTED_RELAY
DEVICE_SESSION
DEVICE_TRANSPORT
LOCAL_EXECUTOR
TOOL_ROUNDTRIP
```

A heartbeat/presence process alone is insufficient.

## Local prototype

Source:

`src/remote-control-plane-model.ts`

The prototype is deliberately in-memory and transport-independent. It does not create accounts,
OAuth clients, tunnels, Supabase projects, public endpoints, keys, billing resources or remote
services.

It models:

- account authentication readiness;
- one-time verified enrollment grant consumption;
- account/device/client/key binding;
- device session generation;
- explicit transport/executor/tool-roundtrip health;
- explicit account-scoped routing;
- end-to-end request correlation;
- duplicate/provider retry recovery;
- dispatch/effect correlation;
- expiration and UNKNOWN outcomes;
- device revocation before and after dispatch.

## Mandatory M7 failure matrix

`test/remote-control-plane-model.test.ts`

Measured 11 / 11 PASS:

1. verified pairing grant is single-use and device-key-bound;
2. heartbeat/session without executor/tool roundtrip is not Ready;
3. connector access-token expiry -> ACCOUNT_AUTH failure; refresh permits only a new request;
4. relay delivery loss after dispatch -> UNKNOWN; provider retry does not reexecute;
5. device transport reconnect increments session generation and does not revive rejected calls;
6. executor child crash is reported at LOCAL_EXECUTOR; local agent restart preserves durable call identity;
7. duplicate delivery/provider retry returns the same durable result/state;
8. delayed response after dispatch expires to UNKNOWN;
9. concurrent calls retain independent request/effect correlation;
10. device revoke before dispatch rejects; revoke mid-call -> UNKNOWN/no retry;
11. wrong-device routing fails before device transport and preserves stable request correlation.

These cover the M7 roadmap failure classes at the control-plane semantic level. Real token refresh,
real relay-loss/reconnect and real hosted transport remain later hosted-beta acceptance work.

## Existing relay regression

Existing experimental relay tests plus the new architecture model:

```text
38 / 38 PASS
```

Coverage includes:

- encrypted durable local result store;
- restart -> UNKNOWN for interrupted execution;
- wrong-secret result refusal;
- expired call cleanup;
- bounded reconnect jitter;
- new cryptographic session after channel loss;
- authenticated tool call exact-once local claim;
- duplicate call non-reexecution;
- result recovery after transport failure;
- replay/direction/session/device mismatch rejection;
- bounded fragmented relay messages;
- Supabase adapter public-key/URL restrictions.

Passing these tests does not promote the current Supabase/shared-secret lane to production identity.

## Local product regression

```text
npm run test:wag-product
58 / 58 PASS
```

M7 does not change the current local product surface.

## Static/package verification

```text
npm run typecheck  = PASS
npm run build      = PASS
npm pack --dry-run = PASS
git diff --check   = PASS
```

The package build contains `dist/remote-control-plane-model.js`, but the prototype is not wired into
the product CLI/server and has no live authority.

## Commercial boundary accepted by M7

### Free/local

- local install/update/doctor/recovery;
- local/private MCP;
- local tools and effect authority;
- supported provider-native local/private reachability.

### Paid hosted WAG Remote

Potential hosted value boundary:

- WAG account;
- device pairing/directory/revoke;
- hosted MCP endpoint;
- provider-neutral outbound remote reachability;
- multi-device routing;
- layered remote health;
- hosted request correlation;
- bounded usage/accounting/support plane.

Exact pricing is not decided by M7.

## Remaining production gates

Before hosted WAG Remote can enter a real private beta:

1. choose OAuth/OIDC authorization stack with Device Authorization support;
2. implement asymmetric per-device client authentication;
3. choose the replaceable outbound device transport;
4. build persistent hosted account/device/request stores;
5. implement real token/revoke lifecycle;
6. rerun the failure matrix against real hosted transport;
7. complete a second-provider MCP workflow;
8. document hosted payload data path and retention;
9. validate any DPoP lane against its actual transport;
10. do not deploy/spend until the M8 private-beta/commercial validation plan justifies it.

No public push was performed.
