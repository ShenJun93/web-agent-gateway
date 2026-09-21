# The v5 native host is registered — verified read-only

2026-09-21. Branch `feat/goal-ui-delegation-v1`. A human performed the registration; Claude changed
no registry key and issued no grant.

## What was verified

```text
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.openai.web_agent_gateway_v5
  (default) = E:\...\claude-autonomous-wag-harness-v1\artifacts\delegation-adapter\
              com.openai.web_agent_gateway_v5.json                                   PRESENT

manifest name            com.openai.web_agent_gateway_v5      matches the key
manifest type            stdio
manifest path            ...\artifacts\delegation-adapter\wag-native-host-v5.exe     EXISTS
  sha256                 3f69cbcb22d37cff84960bcee6eff8c2584fedfa6dfcd448cd729f3e29e53abe
allowed_origins          chrome-extension://nnhhhppkpogkedpjnijeagcbfjaoogec/
  matches                BROWSER_ADAPTER_EXTENSION_ID in native-host-distribution.ts

v4 host                  com.openai.web_agent_gateway -> its own dev install           UNTOUCHED
```

The registered executable is the same path `scripts/verify-delegation-native-host.ts` spawns, and it
was re-run against it: 12/12, including a full DELEGATED_RUN over real stdio, a refused replay, a
`RESULTED` durable row and exactly one slot spent.

## The next step is not the one it looks like

`--sessions` cannot return anything yet, and the reason is structural rather than a matter of
waiting. Measured on this tree:

```text
repositoryEngineering.mutation.goalUiDelegationId    (unset)
delegation discovery file                            absent
WAG gateway process                                  not running
E:/AI-BROWSER/.../wag-mutation.sqlite                absent
```

The chain, each link read from the source rather than assumed:

1. `browser-operator-runtime.ts` constructs the **entire** v5 surface — dispatch server, discovery
   file, sweeper — inside `if (delegationId !== undefined)`. With `goalUiDelegationId` unset, none
   of it exists. That is ADR-0029's off-by-default, working.
2. `native-host-delegation-main.ts` calls `loadDelegationAdapterDiscovery(...)` before it serves a
   single frame. No discovery file, no host.
3. `createDelegatedRunAttempt` calls `delegation.ensureReady(...)`, catches the failure and returns
   `undefined` — "the ordinary state of a machine that has not enabled delegated Run".
4. So no v5 session is minted, and `listAdapterSessions` has nothing to list.

There is a second gate in the same chain worth knowing about: the v5 port is opened **lazily**, when
the extension observes a provider message whose parsed call carries a `workspace_id`. Loading the
extension and opening the side panel is not enough; a delegatable candidate has to be observed.

This is the bootstrap order `scripts/delegation-control.ts --help` already documents: name a
placeholder first, so that WAG serves v5 and refuses every dispatch with `DELEGATION_NOT_FOUND`,
which is exactly the state in which a session can be minted safely.

## One honest caveat about the command

`--sessions` issues nothing, names nothing and widens nothing — it calls `listAdapterSessions` and
prints. But it is **not** read-only against the filesystem: `new SqliteDurableStore(path)` creates
the file if it is absent. Measured, not assumed — running it against a fresh temporary path created
an empty store with the full schema.

Running it before WAG has started would therefore create an empty store at the configured
`statePath`. Harmless, because it is the same schema WAG creates, but avoidable by running it after
the gateway is up.

## What Claude did not do

No registry key read or written beyond the read above. No delegation or lease issued, named,
widened, renewed or revoked. `goalUiDelegationId` and `goalLeaseId` remain unset, and naming either
is refused by the guard a human applied earlier today.
