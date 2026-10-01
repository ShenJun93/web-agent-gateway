# WAG Remote-Effect Bypass Closure v1 — Source Checkpoint

**Date:** 2026-09-26  
**Branch:** `feat/remote-effect-bypass-closure-v1`  
**Implementation parent:** `24616f788fe50e6fee46ddc3f11a6672da058eec`  
**Scope:** close known direct Git/GitHub CLI remote-mutation bypasses on generic execution surfaces before commercial productization.

## Implemented boundary

The new policy is `src/remote-effect-policy.ts`.

It is applied before process dispatch on:

- DevSpace-backed `command.run`;
- DevSpace-backed `verify.run`;
- native `machine.command.run`;
- native `machine.process.start`;
- in-process `machine.terminal.input`;
- persistent terminal-broker input.

The direct argv policy:

- parses Git global options before resolving the effective subcommand;
- denies `git push`;
- denies `git send-pack`;
- denies direct `git-send-pack` and `git-http-push`;
- denies injected Git alias configuration;
- resolves configured aliases for unknown subcommands and denies them;
- denies unrecognized external Git subcommands;
- denies all `gh` CLI invocation through generic execution in this v1 slice;
- accepts an explicit bounded set of ordinary Git subcommands.

Recognized shell command text is scanned before spawn. Interactive terminal input keeps a bounded cross-chunk buffer so a literal Git/GitHub CLI token split across MCP input chunks is still denied before the completing chunk is written to the shell.

## Explicit residual boundary

This checkpoint is **not network isolation**.

It does not prove that arbitrary interpreters, wrappers, custom binaries, or generic network-capable programs cannot create an external effect. Examples include PowerShell obfuscation, Python, Node.js, curl, SSH, WSL, custom executables, or another program that independently speaks a remote protocol.

Accordingly, this checkpoint closes the known direct Git/GitHub CLI bypass class. It does **not** claim that every possible remote effect must pass through a WAG-owned grant path.

A bounded Human-gated remote Git push grant/executor is **not implemented** here.

## Verification

Focused policy suite:

```text
test/remote-effect-policy.test.ts
8 / 8 PASS
```

Covered cases include:

- direct `git push`;
- `git -C ... push`;
- `git -c ... push`;
- `git --git-dir ... push`;
- `git --work-tree ... push`;
- `git send-pack`;
- direct `git-send-pack`;
- direct `git-http-push`;
- Git alias injection;
- configured aliases;
- unknown external Git subcommands;
- `gh` CLI;
- literal shell indirection;
- encoded PowerShell command text;
- split interactive-terminal input;
- DevSpace `command.run` / `verify.run` pre-dispatch denial;
- local-machine command/process/terminal denial;
- persistent terminal-broker denial.

Related regression suites:

```text
test/repository-engineering-runtime.test.ts   13 / 13 PASS
test/dc-replacement-surface.test.ts           15 / 15 PASS
test/direct-mcp-readiness.test.ts             10 / 10 PASS
npm run typecheck                              PASS
npm run build                                  PASS
git diff --check                               PASS
```

The existing local-machine DC-parity suite was run on both the unchanged parent worktree and this candidate:

```text
parent 24616f78: 6 / 8 PASS
candidate:       6 / 8 PASS
```

The same two tests failed in both worktrees on this host:

- `local-machine interactive terminal supports bounded input/output and close`;
- `persistent terminal broker reconnects after LocalMachineContext reconstruction`.

Both failed because expected terminal output was empty in the current host environment; one parent/candidate run also observed an `EBUSY` cleanup race. This checkpoint does not claim those pre-existing terminal acceptance failures are fixed.

A complete `npm test` result for this checkpoint is **not measured**. A full-suite run was started but did not finish within the bounded observation window and was interrupted; no pass/fail claim is made for that run.

## Runtime status

This source checkpoint has **not been promoted**.

The live WAG runtime remains the prior 50-tool runtime at:

```text
db341ff38e15335f5729d2399deddadfab17f853
```

No Git push, remote repository mutation, live-config mutation, or runtime promotion is authorized by this checkpoint.
