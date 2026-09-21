# ADR-0025: Run Configured Verifications Through an Argv Runner With a Constructed Environment

Date: 2026-09-20
Status: Accepted
Depends on: ADR-0014, ADR-0016, ADR-0018, ADR-0020, ADR-0024
Research: `docs/research/2026-09-20-wag-git-execution-surface.md`

## Context

`verify.run` is the only WAG capability that executes something other than git. A locally
configured profile names an argv, a bounded environment, a timeout and an output budget; the
model may select a profile by name and nothing else.

The execution backend accepts one `cmd.exe` command string, so the profile was rendered as a
shell string:

```text
set "DEVSPACE_OAUTH_OWNER_TOKEN=" && set "NODE_ENV=test" && npm test
```

Three things were wrong with that, and none of them is about the profile contract.

**The child inherited everything.** One secret was scrubbed by name. Every other variable in the
execution backend's environment — which is whatever the operator's shell exported when they
started it — reached the verification. The test asserting otherwise passed only because the test
*fixture* launches the backend through `sanitizeDevspaceEnvironment`. In production WAG connects
to a backend it did not start, so that module never runs; it is dead code outside tests. The
guarantee the test appeared to give did not exist in production.

**Safety rested on a character class.** `SAFE_ARG` forbids every shell metacharacter, which is
why the interpolation was survivable. It is also why an argument can never contain a space.

**Cancellation did not reap descendants.** WAG cancels by sending Ctrl+C through the backend's
stdin channel. That does not terminate a process tree, so a wedged grandchild outlived the job.

## Decision

Verifications run through a WAG-owned runner, using the mechanism ADR-0024 accepted for git: the
runner is gzipped and base64url-encoded, evaluated by a `node -e` stub, and everything the
profile contributes travels beside it as a separate base64url JSON argument. Only WAG's own
compile-time constant is ever evaluated; the argv, the profile environment and the deadline are
parsed as data.

```text
node -e "<stub>"  <gzip+base64url runner>  <gzip+base64url {argv, env, treeKillAfterMs}>
```

The runner:

- **builds the environment upwards from an allowlist.** A variable reaches the verification only
  if WAG names it or the profile declares it. `NODE_OPTIONS` is absent by construction, because
  it can inject `--require` into every Node-based verification;
- **spawns the argv directly**, with `shell: false`. On Windows it resolves the executable
  through `PATHEXT` first, because `npm` and its peers are `.CMD` shims and the extensionless
  entry is a POSIX script that cannot be spawned. A shim is invoked through `ComSpec` with the
  whole command wrapped in one extra pair of quotes, which is what `cmd.exe /s /c` requires for a
  path containing spaces;
- **reaps the process tree** on interrupt and at its own deadline, with `taskkill /T /F` on
  Windows and a process-group kill elsewhere.

The runner's deadline sits deliberately *after* the executor's yield, so it never changes what
WAG reports. A verification that exceeds its timeout is still `EXECUTION_TIMEOUT_UNCONFIRMED`
(ADR-0016). The deadline's only job is to stop an abandoned tree from outliving the job.

### Process containment: no new dependency

Windows Job Objects were evaluated for task-owned process-tree ownership. They are not adopted,
because `taskkill /pid <p> /T /F` already terminates the tree — measured here against a
three-deep chain — and it is the same mechanism the execution backend uses for its own
cancellation. A Job Object would add kill-on-close, which needs a native module WAG is not
authorized to add on this evidence. Reaping on interrupt and at a deadline covers the failure
this milestone actually observed.

Unrelated processes survive: the kill is rooted at the child WAG spawned, never at a name or a
pattern.

### Network authority, stated rather than implied

A verification can reach the network. WAG does not prevent it, and this ADR does not pretend
otherwise.

What WAG does provide is narrower and real: the child's environment is constructed, so no
credential, token, proxy setting or API key from the operator's shell or from the execution
backend reaches the verification unless the profile names it — and `resolveVerifyProfile` rejects
any profile environment key matching `TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL`. A
verification that does reach the network reaches it unauthenticated as far as WAG is concerned.

No `network = denied` field is added. Enforcing it would require machine-wide firewall or
security-policy mutation, which is outside the authority of this work, and a field that names a
control WAG does not implement is worse than no field.

The accepted primary repository-engineering workflow — inspect, read, diff, reviewed edit,
reviewed create, verify, reviewed commit — does not require network-capable execution. Profiles
that do are the operator's own choice, made locally in a config file the model cannot influence.

## Consequences

Accepted:

- the argv and the profile environment are data, not syntax, on the last path where they were not;
- the verification's environment is constructed rather than inherited, and that property now
  holds in production rather than only under the test fixture;
- cancellation and abandonment reap the process tree, and unrelated processes survive;
- no new dependency, no new listener, no change to the verify profile contract or its plan hash.

Not accepted, and stated rather than implied:

- network isolation of a verification;
- kill-on-close process containment, which would need a native Job Object dependency;
- containment against a fully compromised same-user account, unchanged from ADR-0017/0019;
- anything about processes the execution backend starts for its own purposes.

## Security invariants

```text
VERIFY_EXECUTION = ARGV_NOT_SHELL
VERIFY_CHILD_ENVIRONMENT = ALLOWLIST_CONSTRUCTED
VERIFY_INHERITED_SECRETS = NONE
NODE_OPTIONS_IN_VERIFY = NEVER
VERIFY_CANCELLATION = REAPS_TASK_OWNED_TREE
UNRELATED_PROCESSES = SURVIVE
VERIFY_TIMEOUT_EVIDENCE = UNCHANGED_BY_THIS_ADR
VERIFY_NETWORK_ISOLATION = NOT_PROVIDED_AND_NOT_CLAIMED
JOB_OBJECT_NATIVE_DEPENDENCY = NOT_ADDED
```

## Decision markers

```text
ADR_0025 = ACCEPTED
NEW_DEPENDENCY = NONE
NEW_EXECUTION_PRIMITIVE = NONE
VERIFY_PROFILE_CONTRACT_CHANGE = NONE
ARBITRARY_SHELL_SURFACE = STILL_NOT_PROVIDED
```
