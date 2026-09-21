# P1 ChatGPT -> WAG Direct Access v1 — Single-Session Acceptance

Date: 2026-09-21  
Status: acceptance contract / provider-account actions not yet authorized  
Canonical base: `40d9c33d25c56317d247e2a659fac0ed4f003f2d`

## Objective

Prove that a normal ChatGPT conversation can use WAG directly for bounded local **read/verify** work without Remote Desktop Commander and without a browser-extension execution path.

Target topology:

```text
ChatGPT
  -> OpenAI-hosted MCP tunnel endpoint
  -> Secure MCP Tunnel
  -> customer-run tunnel-client
  -> stdio child
  -> WAG serve-stdio
  -> DevSpace
  -> approved local workspace
```

OpenAI's current tunnel-client supports stdio MCP bindings directly, so P1 S1 introduces **no custom transport proxy and no WAG runtime shim by default**.

Primary sources:
- https://github.com/openai/tunnel-client
- https://github.com/openai/tunnel-client/blob/master/docs/connectors.md
- https://github.com/openai/tunnel-client/blob/master/docs/architecture.md
- https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

## Existing WAG surface

Canonical `main` already contains the production stdio runtime:

```text
node dist/cli.js serve-stdio --config <absolute-private-config>
```

With repository engineering disabled, the surface is exactly:

```text
health
workspace.open
repo.snapshot
file.read
verify.run
```

P1 S1 uses exactly this default surface.

Do not enable:

- `repositoryEngineering`;
- `mutation.preview`;
- `file.create`;
- `mutation.result`;
- `git.commit`;
- `git.commit.result`;
- Goal Lease;
- browser operator/extension authority;
- shell, PTY or generic process execution.

## Trust boundary

The Secure MCP Tunnel is transport, not authority.

The following are correlation/routing only and must not become WAG authority:

- tunnel id;
- OpenAI product conversation/session metadata;
- MCP request id;
- tunnel-client process/connection id;
- ChatGPT user-visible conversation identity.

WAG continues to mint its own session/workspace identities and fixed trusted adapter identity for private stdio.

The remote caller must not be able to provide owner/session/adapter authority fields.

## Secrets and configuration

Never commit:

- OpenAI runtime/admin API keys;
- tunnel credentials;
- DevSpace owner token;
- machine-specific private config;
- operator bootstrap material.

WAG private JSON remains non-secret. The DevSpace owner token remains environment-only.

Secure MCP Tunnel requires outbound HTTPS; WAG itself still exposes no public listener.

## Provider-side gate

Creating/selecting a tunnel, creating or revealing API keys, changing ChatGPT workspace/app settings, publishing/enabling a custom MCP app, or other OpenAI account/resource mutations are **provider actions**.

They require explicit authorization before execution.

Read-only research and local/GitHub preparation do not grant that authority.

## Acceptance procedure

### A. Canonical/local readiness

1. Fresh-check canonical `main` and record exact SHA.
2. `npm ci`.
3. `npm run build`.
4. Start the separately supervised exact-pinned DevSpace on loopback.
5. Set `DEVSPACE_OAUTH_OWNER_TOKEN` in process environment only.
6. Run:
   ```text
   node dist/cli.js doctor --config <private-config>
   ```
7. Confirm the private config contains approved roots and bounded verify profiles only; no repository-engineering profile for S1.

### B. Tunnel readiness

Using the supported OpenAI tunnel-client:

1. bind the tunnel's `main` channel directly to the WAG stdio command;
2. run `tunnel-client doctor --profile <profile> --explain`;
3. confirm no inbound public MCP listener is opened;
4. start exactly one active tunnel-client for the tunnel id when using stdio.

The stdio restriction matters: OpenAI documents one active tunnel-client instance per tunnel id for stdio bindings.

### C. ChatGPT single-session proof

From one normal ChatGPT conversation, using only the connected MCP app:

1. list tools and prove the visible set is exactly the five S1 tools;
2. call `health`;
3. call `workspace.open` for one approved workspace and obtain an opaque workspace id;
4. call `repo.snapshot`;
5. call `file.read` on a known sentinel/source file and verify exact expected content;
6. call one configured `verify.run` profile;
7. call a final `repo.snapshot`;
8. prove the workspace remained byte-identical if the verification profile is expected to be non-mutating.

No Desktop Commander call is permitted in this proof.

### D. Negative/security proof

Prove from the same ChatGPT surface that:

- arbitrary tool names reject;
- `mutation.preview`, `file.create`, `git.commit`, raw shell and PTY are absent;
- a raw local path cannot be substituted for the opaque workspace id after opening;
- an unapproved root is refused;
- an unknown verify profile is refused;
- caller-supplied authority/correlation fields are rejected by strict schemas;
- stdout remains MCP framing only;
- stderr/logs contain no owner token, API key, workspace content or raw secret.

### E. Restart/cleanup

1. close the ChatGPT/tunnel test path;
2. stop the task-owned tunnel-client/WAG/DevSpace processes only;
3. prove no task-owned child remains;
4. prove no repository content changed unexpectedly;
5. preserve a dated acceptance receipt with exact WAG SHA, tunnel-client version, tool list and measured results.

## Cutover rule

When A-E pass:

```text
CHATGPT_LOCAL_READ_VERIFY = WAG_PRIMARY
DESKTOP_COMMANDER = FALLBACK_ONLY
```

This is the first point at which ChatGPT itself should stop using Desktop Commander for WAG-supported local read/verify work.

It does **not** authorize mutation or Git writes.

## Next gates after S1

### S2 — isolation/restart/performance

Prove at least five independent ChatGPT sessions do not cross-own workspace/session state, then measure restart/reconnect and latency behavior.

### S3 — bounded mutation

Only after S1/S2 pass, separately authorize the repository-engineering mutation projection and Goal Lease integration for the direct ChatGPT path.

### S4 — bounded Git

Add status/diff/commit under WAG's exact repo/HEAD/CAS authority. Push/PR/merge/release/signing remain separate authority classes.

## Decision markers

```text
P1_S1_TRANSPORT = OPENAI_SECURE_MCP_TUNNEL
P1_S1_LOCAL_BINDING = STDIO_DIRECT_TO_WAG
CUSTOM_TRANSPORT_PROXY = NO
WAG_RUNTIME_CODE_CHANGE_REQUIRED = NOT_PROVEN
VISIBLE_TOOL_COUNT = 5
MUTATION = OFF
GIT_WRITE = OFF
GOAL_LEASE = OFF
DC_CUTOVER_AFTER_S1 = READ_VERIFY_ONLY
PROVIDER_ACCOUNT_ACTION = EXPLICIT_AUTHORIZATION_REQUIRED
```
