# P1 ChatGPT -> WAG v1 — Plus Value Proof, then Business Direct Cutover

Date: 2026-09-21  
Status: staged acceptance contract; no provider-account action authorized  
Canonical base at creation: `40d9c33d25c56317d247e2a659fac0ed4f003f2d`

## Decision

Do not require a ChatGPT Business upgrade merely to test whether WAG is useful.

P1 is split into two explicit stages:

```text
P1A — current ChatGPT Plus
ChatGPT page
  -> existing WAG browser extension/native host
  -> WAG browser admission / read-verify surfaces
  -> approved local workspace

P1B — conditional future ChatGPT Business
ChatGPT custom MCP app
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client
  -> direct stdio child
  -> WAG serve-stdio
  -> DevSpace
  -> approved local workspace
```

The Business upgrade is a product decision made **after** P1A produces measured value. P1B remains the preferred direct structured-provider path if that upgrade happens.

## Current product constraint

As of 2026-09-21, OpenAI's official ChatGPT documentation says apps/full MCP/developer mode are available to Business and Enterprise/Edu. The same FAQ gives Pro a read/fetch-only MCP exception. Plus is not listed as an eligible custom-MCP/developer-mode plan.

Therefore the project must not assume that the current Plus account can create or use the custom MCP app needed for Secure MCP Tunnel acceptance.

Primary source:
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

This is a product-access constraint, not a WAG architecture failure.

## P1A — Plus/browser value proof

### Objective

Measure whether WAG already provides enough real local-development value through the accepted browser/native path to justify making WAG primary and, later, paying for the cleaner Business direct-MCP path.

P1A is not an architecture rewrite. Reuse the already accepted browser/native implementation.

The read-only Browser Inspect v2 surface remains:

```text
health
workspace.open
repo.search
repo.snapshot
file.read
```

Where verification is included, use only the already accepted browser verification proposal/result path. Do not widen the browser authority merely for this benchmark.

### Human-presence rule

Browser `Run` remains human because it is the transition from untrusted page content into a WAG proposal.

For consequential browser proposals, the existing local review/approval rule remains in force unless a separately authorized Goal Lease configuration is deliberately enabled.

P1A must **measure** these gestures rather than hiding them.

No automatic browser click, DOM-to-effect shortcut or provider-page authority is permitted.

### Representative workload

Use real WAG-development work rather than synthetic hello-world calls.

The measurement set should include:

- repository inspection/search tasks;
- exact bounded file reads;
- repository snapshots before/after work;
- at least one bounded verification flow if the accepted browser verify surface is available;
- reconnect/reload/restart cases that normally cause operator friction.

Desktop Commander may be used only as an explicitly recorded fallback when WAG cannot complete a task.

### Evidence to record per task

For every measured task record:

```text
task_id
goal
WAG surface/tool(s)
success/failure
DC fallback used? yes/no
human Run count
human Approve count
extension/native reconnect needed? yes/no
elapsed transport/tool time
unexpected reload/manual repair
authority/result identifiers where applicable
security or isolation anomaly
```

Do not include secrets, raw credentials or unrelated workspace content in receipts.

### P1A acceptance

P1A passes as a **value proof** when all of the following are true:

1. At least 10 representative local-development tasks are measured.
2. At least 9 of 10 complete without Desktop Commander fallback.
3. No task requires raw shell, generic filesystem authority or authority widening to succeed.
4. No cross-session/workspace ownership failure, secret exposure, unexpected effect or fail-open behavior occurs.
5. Browser/native reconnect/reload behavior is stable enough that failures are exceptional rather than the normal workflow.
6. The remaining material friction is attributable mainly to the browser/provider transport or required human gestures, not to missing WAG semantic capabilities.

Latency and gesture counts are recorded as measurements, not silently converted into a purchase decision.

### P1A cutover

If P1A passes:

```text
CHATGPT_PLUS_SUPPORTED_READ_INSPECT = WAG_PRIMARY
DESKTOP_COMMANDER = FALLBACK_ONLY_FOR_UNSUPPORTED_OR_RECOVERY_CASES
BUSINESS_UPGRADE = EVIDENCE_SUPPORTED_BUT_STILL_USER_DECISION
```

This cutover is workflow-scoped. It does not claim WAG replaces every Desktop Commander capability.

## Business upgrade decision gate

Do not upgrade solely because Secure MCP Tunnel exists.

An upgrade is justified for further testing when P1A shows both:

```text
WAG_CORE_VALUE = PROVEN
DOM_BROWSER_GESTURES_OR_TRANSPORT = MATERIAL_REMAINING_FRICTION
```

If the user chooses to upgrade, continue to P1B. If not, keep the P1A browser/native path and continue improving only measured gaps.

No subscription purchase, workspace creation, billing change or account mutation is authorized by this document.

## P1B — Business/Secure MCP direct cutover

### Objective

After a Business upgrade, prove that a normal ChatGPT conversation can call WAG directly for bounded local read/verify work without Desktop Commander and without browser-extension execution.

Target topology:

```text
ChatGPT Business custom MCP app
  -> OpenAI-hosted MCP tunnel endpoint
  -> Secure MCP Tunnel
  -> customer-run tunnel-client
  -> direct stdio child
  -> WAG serve-stdio
  -> DevSpace
  -> approved local workspace
```

OpenAI's tunnel-client currently supports stdio MCP bindings directly, so P1B introduces no custom transport proxy or WAG runtime shim by default.

Primary tunnel sources:
- https://github.com/openai/tunnel-client
- https://github.com/openai/tunnel-client/blob/master/docs/connectors.md
- https://github.com/openai/tunnel-client/blob/master/docs/configuration.md
- https://github.com/openai/tunnel-client/blob/master/docs/architecture.md

### Existing WAG stdio surface

Canonical WAG already contains:

```text
node dist/cli.js serve-stdio --config <absolute-private-config>
```

With repository engineering disabled, the direct P1B surface is exactly:

```text
health
workspace.open
repo.snapshot
file.read
verify.run
```

P1B read/verify acceptance keeps these disabled:

```text
repositoryEngineering
Goal Lease
mutation.preview
file.create
mutation.result
git.commit
git.commit.result
raw shell / PTY / generic process execution
```

Goal Lease is intentionally off for the first direct-provider proof. Its gesture-free stdio behavior has already been proven independently in P0; it is enabled on the direct ChatGPT path only under a later, separately reviewed authority gate.

## P1B trust boundary

Secure MCP Tunnel is transport, not authority.

These values are routing/correlation only:

```text
tunnel id
ChatGPT conversation/session metadata
MCP request id
tunnel-client connection/process id
provider-visible conversation identity
```

WAG continues to mint local session/workspace/effect identities. The caller cannot assert owner id, trusted adapter id, `HUMAN_APPROVED`, `POLICY_APPROVED`, or Goal Lease issuance.

## P1B secrets and provider gate

Never commit:

```text
OpenAI API/runtime/admin keys
tunnel credentials
DevSpace owner token
machine-specific private config
operator bootstrap material
```

Creating/selecting a tunnel, creating API keys, changing Business workspace settings, enabling developer mode, creating/publishing a custom MCP app, or changing billing/subscription state are provider/account actions and require explicit authorization at the time they are performed.

## P1B acceptance procedure

### A. Local readiness

1. Fresh-check canonical `main` and record exact SHA.
2. Build WAG and start exact-pinned DevSpace on loopback.
3. Set `DEVSPACE_OAUTH_OWNER_TOKEN` through process environment only.
4. Run `node dist/cli.js doctor --config <private-config>`.
5. Confirm the P1B private config exposes only the default read/verify surface.

### B. Tunnel readiness

1. Bind the tunnel's `main` channel directly to WAG's stdio command.
2. Run `tunnel-client doctor --profile <profile> --explain`.
3. Confirm no new inbound public MCP listener exists.
4. Run only one active tunnel-client per tunnel id for stdio binding, matching OpenAI's documented deployment limit.

### C. ChatGPT proof

From one normal ChatGPT Business conversation:

1. prove exactly five WAG tools are visible;
2. call `health`;
3. open one approved workspace;
4. take a repository snapshot;
5. read known bounded content;
6. run one configured verify profile;
7. take the final repository snapshot;
8. prove no unexpected workspace mutation occurred.

Desktop Commander calls in this proof: **zero**.

### D. Negative/security proof

Prove that mutation/Git/raw-shell tools are absent, unapproved roots and unknown verify profiles are refused, strict schemas reject caller-supplied authority fields, and logs contain no credentials or workspace-content leakage.

### E. Restart/cleanup

Close the test path, stop only task-owned tunnel/WAG/DevSpace processes, prove no task-owned child remains, verify repository state, and write an exact dated acceptance receipt.

## P1B cutover

When P1B passes:

```text
CHATGPT_BUSINESS_LOCAL_READ_VERIFY = WAG_PRIMARY
DESKTOP_COMMANDER = FALLBACK_ONLY
BROWSER_EXTENSION_PATH = FALLBACK / PROVIDER_COMPATIBILITY
```

Only after this gate should the direct ChatGPT path consider bounded mutation + Goal Lease, followed later by bounded Git commit. Push/PR/merge/release/signing/provider actions remain separate authority classes.

## Decision markers

```text
CURRENT_TEST_PLAN = CHATGPT_PLUS
P1A = BROWSER_NATIVE_VALUE_PROOF
P1A_BUSINESS_REQUIRED = NO
P1A_GOAL_LEASE = OFF_BY_DEFAULT
P1A_DC_FALLBACK = MEASURED_ONLY

BUSINESS_UPGRADE = CONDITIONAL_ON_P1A_VALUE

P1B = SECURE_MCP_DIRECT_CUTOVER
P1B_PLAN = CHATGPT_BUSINESS
P1B_TRANSPORT = OPENAI_SECURE_MCP_TUNNEL
P1B_LOCAL_BINDING = STDIO_DIRECT_TO_WAG
P1B_CUSTOM_TRANSPORT_PROXY = NO
P1B_VISIBLE_TOOL_COUNT = 5
P1B_MUTATION = OFF
P1B_GIT_WRITE = OFF
P1B_GOAL_LEASE = OFF_FOR_FIRST_ACCEPTANCE

PROVIDER_ACCOUNT_ACTION = EXPLICIT_AUTHORIZATION_REQUIRED
```
