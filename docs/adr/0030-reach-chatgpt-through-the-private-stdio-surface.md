# ADR-0030: Reach ChatGPT Through the Private Stdio Surface and a Secure MCP Tunnel

Date: 2026-09-22
Status: Accepted
Depends on: ADR-0003, ADR-0014, ADR-0015, ADR-0019, ADR-0020, ADR-0025, ADR-0026, ADR-0028
Research: `docs/research/2026-09-22-chatgpt-direct-mcp-route.md`
Evidence: `docs/benchmarks/2026-09-22-direct-mcp-readiness.md`

## Context

ADR-0020 made the private stdio surface WAG's DC-replacement repository-engineering surface and
closed with `SUPPORTED_HOST_WEBCHAT_EVIDENCE = SEPARATE_LATER_GATE`. This is that gate.

The accepted browser path works and is proven end to end
(`docs/benchmarks/2026-09-22-delegated-run-to-leased-effect.md`), but it reaches the model through
a page: the extension observes an assistant turn, WAG turns text into a proposal, and results
return through the panel or through a person. That is a relay, and AGENTS.md is explicit that
"recurring manual prompt relay, hidden DC fallback, or browser-automation dependence is not an
acceptable production success state."

AGENTS.md also ranks the alternatives: "Prefer provider-native remote/private MCP or another stable
standard path before building a provider browser adapter." The provider-native path now exists.

## Decision

**The direct provider path is the existing private stdio MCP surface, carried by OpenAI's Secure
MCP Tunnel in its stdio mode. WAG adds no transport, no surface and no new authority.**

```text
ChatGPT connector
  -> OpenAI-hosted tunnel endpoint
  -> tunnel-client on this machine        (outbound HTTPS long poll only)
  -> node dist/cli.js serve-stdio         (child process; stdin/stdout; no port)
  -> WAG control plane                    (workspace ownership, CAS, replay, approval or lease)
```

### 1. The tunnel is transport, and is never an authority plane

`tunnel-client` moves JSON-RPC bytes. It carries no identity WAG honours, and it cannot assert one:
the caller tuple on this surface is derived locally and is not negotiable by the client (ADR-0015,
ADR-0020 §5). `ownerId` comes from local configuration, `sessionId` is minted per gateway process,
and `adapterId` is the fixed literal `private.stdio.v1`.

A tunnelled client is therefore the *stdio* caller and nothing more. It cannot read, resume, adopt
or alias a workspace owned by any browser adapter identity, because ownership is the full tuple and
the adapter differs. No ownership transfer is introduced, and none is possible.

### 2. Nothing is exposed to the network, but a process boundary is shared

The tunnel exists precisely so that a private server stays private. WAG opens no listening socket
on this path: `serve-stdio` speaks over the pipe it was spawned with, and its stdout carries MCP
frames only. Publishing WAG on a public HTTPS endpoint is rejected; it would create the inbound
surface the tunnel is designed to avoid.

What *is* shared is the process boundary, and it is shared in both directions:

- WAG becomes the vendor client's child, so it inherits that process's environment. `serve-stdio`
  requires `DEVSPACE_OAUTH_OWNER_TOKEN`, which must therefore be held by the vendor process. WAG
  removes it from its own environment after the OAuth exchange and passes it to no child of its
  own, but the parent holds it for its lifetime. **Accepted deliberately, and it must be stated
  rather than discovered.**
- WAG's stderr is read by that parent. It carries the loopback operator origin and the *path* of
  the operator credential file. It does not carry the credential, which is written to a 0600 file.
- Nothing the vendor exports can reach a WAG-spawned child: verify and git child environments are
  built upward from allowlists rather than inherited.

### 3. The tool surface is the accepted one, unchanged

The loop a direct client needs already exists and is already accepted:

```text
workspace.open -> repo.* / file.read -> mutation.preview | file.create -> mutation.result
               -> verify.run -> git.commit -> git.commit.result
```

No tool is added, renamed, widened or given a new argument. The local opt-in of ADR-0020 §3 still
governs which of them exist: absent configuration, `serve-stdio` is the accepted five.

### 4. Annotations on this surface are a security contract, not documentation

Every previous consumer of this surface was ours. A tunnelled client is not: it decides whether to
ask its user to confirm a write from the tool annotations alone, and ADR-0020 already recorded the
provider's warning that a read-only annotation may cause that confirmation to be skipped.

Therefore, on the direct surface:

- every tool declares all four hints explicitly, so none silently inherits a specification default;
- no tool that changes durable state may declare `readOnlyHint: true`;
- every tool that takes arguments refuses unknown ones rather than stripping them in silence.

`workspace.open` declared `readOnlyHint: true` while canonicalising a root, opening a DevSpace
workspace and minting a durable caller-owned record. That is corrected. Four of the five oldest
tools also accepted unknown arguments and dropped them silently; they are now strict, matching what
every tool added since already did.

### 5. A stable session, because otherwise autonomy on this surface is unreachable

Transport readiness is not the acceptance target. The target is ChatGPT working without a human
between normal bounded steps, and that needs a Goal Lease to be able to admit on this surface.

It could not. A lease admits only the sessions listed in its own durable row, while `serve-stdio`
minted `sid_${randomUUID()}` per process and never emitted it — so no lease could name the session
it would actually meet. Under a tunnel this is worse than a nuisance: the process lifetime belongs
to the vendor client, so every reconnect was a new identity. Autonomous admission here was not
unused, it was **unreachable**, while the startup profile reported autonomous admission as enabled.

That is a WAG-side blocker, and it is fixed by reusing the mechanism the browser adapters have had
since ADR-0017 rather than by inventing one:

```text
repositoryEngineering.mutation.sessionCorrelation   (local configuration, human-written)
  -> adapterCorrelationDigest(ownerId, 'private.stdio.v1', correlation)
  -> store.getOrCreateAdapterSession(...)  -> the same session_… on every start
```

Bounded exactly as the browser path is bounded:

- **Session matching is untouched.** `admittedSessions` still requires an exact match; what changed
  is that the session can now be known in advance and stay the same.
- **No parallel authority plane.** This resolves a row in the existing `adapter_sessions` table
  through the existing derivation, which is exported rather than copied.
- **Cross-adapter acquisition is impossible by construction.** `ownerId` and `adapterId` are inside
  the digest, and `adapterId` here is the fixed stdio literal — so an identical correlation string
  used by any browser adapter, or configured under another owner, is a different session and cannot
  inherit this one's lease.
- **The correlation is local configuration only** — never a tool argument, the transport, the
  client's environment or repository text — and must carry the strong
  `OPERATOR_CORRELATION_PATTERN` shape, because whoever can choose the string joins the session and
  this surface can propose changes. Writing it is a human act, exactly like naming a lease.
- **The default is unchanged.** Absent a correlation, the session is still fresh per process
  (ADR-0020 §5), and no durable session row is created at all.
- **A lease named without a correlation now fails at startup**, rather than denying silently
  forever while the profile claims autonomy is on.

Discovery is the same bootstrap problem the browser path already solved with
`listAdapterSessions`: a human issuing a lease must be able to find the session id to bind. The
gateway therefore reports `stableSessionId` on its startup profile when, and only when, one is
configured. A session id is an identity, not a credential; it grants nothing without a lease row a
human wrote.

### 6. Provider confirmation composes above WAG and is never claimed away

ChatGPT may require its user to confirm a write action, and may block some actions outright. That
gate is inside the client, upstream of any WAG code. The composition is a conjunction: the client's
confirmation **and** WAG's authority.

**A Goal Lease admits an action on WAG's side only. It cannot suppress a confirmation imposed by
ChatGPT, and no evidence produced under this ADR may be presented as showing that it can.**
Equally, a provider confirmation is not a substitute for local approval: with no lease named,
ADR-0026 holds in full and every effect still needs the local operator.

## Why this is not authority widening

- No new execution primitive, tool, argument, listener, port, elevation, dependency or OS boundary.
- No new policy engine, workspace model, approval system or durable state machine — the mission's
  constraint, and the reuse order (`COMPOSE`, not `BUILD`) is satisfied at the top.
- No protocol version and no adapter identity change. `private.stdio.v1` is unchanged.
- The two corrections in §4 are both *narrowing*: they declare more risk to the client and refuse
  more input than before.

## Consequences

Accepted:

- WAG may be connected to a supported OpenAI surface through Secure MCP Tunnel on a machine where
  the extended stdio profile is configured, without further architecture work.
- The browser extension path remains, unchanged and unremoved, as the fallback.
- Readiness may be claimed from local evidence. **Provider end-to-end capability may not**: it
  depends on plan eligibility this project does not control, and must be recorded separately.

Consequences that are properties of the composition, not decisions:

- **Autonomy on this surface is opt-in twice over.** It needs a `sessionCorrelation` in local
  configuration *and* a lease a human issued for the session that correlation resolves to. With
  neither, the surface behaves exactly as it did before this ADR: local operator approval for every
  effect, ADR-0026 in full. The fix removed an unreachable path; it did not turn anything on.
- **One unwired factory still violates the rule in §4.** `createBrowserAdmittedMcpServer` declares
  `workspace.open` read-only while it mints a durable record. It has no production caller — only
  tests construct it — so nothing shipped is affected and the browser fallback is unaffected. It is
  recorded as a residual, and the invariant below is scoped to the direct surface honestly rather
  than stated globally and quietly contradicted.

Not accepted by this ADR:

- **starting a tunnel.** Running `tunnel-client` attaches WAG's mutation and commit surface to a
  remote model. That is an operator act, not an automation act: no agent may start one, and the
  binding constraint is real rather than procedural, because the tunnel id and runtime API key are
  account actions no agent here can perform;
- exposing WAG on a public or non-loopback endpoint, or publishing a plugin;
- treating tunnel identity, connector identity or any provider-side confirmation as WAG authority;
- purchasing, enrolling or creating any external provider resource;
- any claim that a lease, delegation or WAG setting affects a provider-imposed confirmation;
- any relaxation of local operator approval, CAS, replay protection or workspace ownership.

## Security invariants

```text
DIRECT_PROVIDER_SURFACE    = PRIVATE_STDIO_UNCHANGED
TUNNEL_ROLE                = TRANSPORT_ONLY
TUNNEL_AS_AUTHORITY        = FORBIDDEN
INBOUND_NETWORK_EXPOSURE   = NONE
CALLER_TUPLE_SOURCE        = WAG_LOCAL_ONLY
OWNERSHIP_TRANSFER         = IMPOSSIBLE_ACROSS_ADAPTERS
ANNOTATION_COMPLETENESS    = REQUIRED_ON_DIRECT_SURFACE
READ_ONLY_WHILE_MUTATING   = FORBIDDEN_ON_DIRECT_SURFACE
UNKNOWN_ARGUMENTS          = REFUSED_NOT_STRIPPED_ON_DIRECT_SURFACE
DEVSPACE_TOKEN_HOLDER      = THE_VENDOR_PARENT_PROCESS
SESSION_IDENTITY_SOURCE    = LOCAL_CONFIG_CORRELATION_VIA_ADR_0017_DERIVATION
SESSION_MATCHING           = UNCHANGED_EXACT
CROSS_ADAPTER_ACQUISITION  = IMPOSSIBLE_BY_DIGEST_DOMAIN_SEPARATION
STABLE_SESSION             = OPT_IN_AND_HUMAN_WRITTEN
LEASE_WITHOUT_CORRELATION  = REFUSED_AT_STARTUP
DEFAULT_SESSION            = STILL_FRESH_PER_PROCESS
PROVIDER_CONFIRMATION      = ABOVE_WAG_AND_NOT_SUPPRESSIBLE
LEASE_SUPPRESSES_PROVIDER  = NEVER_CLAIMED
NOTHING_CONFIGURED         = ADR_0026_UNCHANGED_IN_FULL
BROWSER_PATH               = RETAINED_AS_FALLBACK
```

## Decision markers

```text
ADR_0030 = ACCEPTED
CAPABILITY_ORIGIN = EXISTING_ACCEPTED_COMPONENTS
NEW_TRANSPORT_CODE = NONE
NEW_TOOLS = NONE
PROVIDER_E2E_EVIDENCE = SEPARATE_AND_PLAN_GATED
EXTERNAL_RESOURCE_CREATED = NONE
```
