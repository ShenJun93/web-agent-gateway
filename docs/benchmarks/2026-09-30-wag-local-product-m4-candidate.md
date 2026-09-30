# WAG Local M4 — Update / Rollback / Uninstall Candidate

Date: 2026-09-30
Branch: `feat/wag-local-m4-update-rollback-uninstall-v1`
Base: `99cebd15ed3be9c2913c4b1bf689deb6a89f07d3` (M3 doctor/bounded repair)

## Verdict

`M4_TRANSACTIONAL_LIFECYCLE_CANDIDATE = PASS`

`M4_PACKED_RELEASE_MANIFEST = PASS`

`M4_M2_REGRESSION = PASS`

`M4_LIVE_SELF_UPDATE = NOT_MEASURED`

`M4_LIVE_UNINSTALL = NOT_EXECUTED`

This batch implements and fixture-accepts the transactional lifecycle substrate without disrupting
the currently connected WAG Local instance. A real self-update would intentionally replace the
running WSL wrapper and restart the exact tunnel process, which can terminate the active ChatGPT MCP
session. A real uninstall would intentionally remove the live WAG installation. Those are separate
disruptive acceptance boundaries.

## Product surface

The CLI now exposes:

```text
web-agent-gateway update --package-root <absolute-path> [--manifest <absolute-path>] [--output <absolute-path>]
web-agent-gateway rollback [--output <absolute-path>]
web-agent-gateway uninstall [--keep-state] [--remove-managed-devspace] [--output <absolute-path>]
```

All lifecycle paths are bounded to absolute local paths and reject unknown arguments.

## Release contract

Each package carries `RELEASE.json` with schema `WAG_LOCAL_RELEASE_V1`:

- release id;
- semantic package version;
- channel: `stable`, `beta`, or `development`;
- source provenance;
- deterministic payload SHA-256;
- supported Node major floor/ceiling;
- migration version;
- rollback target.

The payload hash is deterministic over the shipped WAG runtime allow-list only. `RELEASE.json`
itself is excluded from its own digest.

Update staging copies only that same allow-list. Untracked or unrelated source-tree files are neither
covered by a misleading release digest nor copied into the installed runtime.

### Provenance rules

Development builds from a dirty Git worktree identify themselves as:

```text
git:<HEAD>+dirty:<payload-prefix>
```

and the release id also contains the dirty payload prefix.

Stable/beta manifest generation refuses a dirty source tree unless an explicit external provenance
has been supplied. A dirty development tree is therefore never represented as a clean Git commit.

A packed tarball was extracted and independently rehashed. Its `RELEASE.json.payloadSha256` matched
the unpacked allow-listed payload exactly.

## Initial installation integration

The M2 installer now consumes `RELEASE.json` when present and independently verifies the package
payload hash before mutation.

The first install:

- uses the manifest release id as the installed runtime directory/tag;
- seeds `WAG_LOCAL_RELEASE_STATE_V1`;
- records channel and migration version;
- records release provenance in `RUNTIME.json` and the setup receipt;
- refuses to use ordinary `setup` to replace a different active release, directing that operation
  through the transactional updater instead.

Legacy/source fallback remains available when no release manifest is present, but packaged releases
have the stronger manifest path.

## Transactional update

Core update semantics:

1. validate manifest, compatibility, migration and rollback target;
2. stage without deleting the current release;
3. hash the staged payload;
4. run candidate acceptance;
5. switch the runtime binding;
6. atomically write active/previous release state;
7. run post-switch product health;
8. on switch or health failure, switch back to the previous runtime and restore previous release
   state.

A partial switch failure also enters the exact rollback path.

The Windows runtime adapter additionally:

- validates the currently bound WSL profile/wrapper;
- requires the pinned exact tunnel-client path;
- stops only the exact WAG recovery supervisor before a switch so it cannot race the updater;
- installs launchers from the candidate;
- writes the WSL wrapper through a unique `mktemp` file followed by atomic rename;
- stops only the exact matching WAG tunnel-client process;
- uses the bounded installed starter;
- restarts the exact WAG recovery supervisor after the stack is Ready;
- requires the product doctor to report `READY` after switching.

## Explicit rollback

`web-agent-gateway rollback` targets the recorded previous release.

The state pointer is updated only after the rollback target passes health. If that target fails health,
the updater restores the originally active runtime.

## Uninstall

The supported uninstall removes only identifiable WAG-owned local artifacts.

By default it removes the WAG runtime/config/logs/browser-profile/bootstrap files and requested local
state while preserving external user workspaces. `--keep-state` preserves state/secrets/receipts.
`--remove-managed-devspace` additionally removes only recognized managed DevSpace state/checkouts.

Before local removal, the runtime attempts bounded cleanup:

- stop exact WAG supervisor;
- stop exact matching WAG tunnel-client;
- stop DevSpace only when PID, command identity and port-7677 ownership all match;
- remove the per-user Startup shortcut only when it targets the WAG supervisor;
- remove WSL profile/wrapper only when the parsed WAG CLI/config paths belong to the WAG install root.

Unknown entries in the install root are preserved. Remote ChatGPT connector deletion is deliberately
not automated; the uninstall receipt reports it as an optional client-side action.

The uninstall receipt is written outside the removed install root.

## Fixture evidence

### Transactional M4 fixture

Receipt:

`docs/benchmarks/2026-09-30-wag-local-product-m4-fixture.json`

Result: **PASS**.

Measured:

- successful update from release-1 to release-2;
- previous release retained as rollback target;
- release-3 post-switch health failure automatically rolls back to release-2;
- explicit rollback from release-2 to release-1 succeeds;
- release metadata contains channel/provenance/hash/compatibility/migration/rollback target;
- switch pointer uses atomic replacement in the fixture;
- uninstall preserves unknown entries;
- uninstall preserves external user workspace;
- selected managed DevSpace artifacts are removed.

### M2 packaged installer regression

Receipt:

`docs/benchmarks/2026-09-30-wag-local-product-m4-m2-installer-regression.json`

Result: **PASS**.

The packaged M2 install now follows the generated release id rather than assuming
`runtime\0.1.0`, while all live-WAG non-interference checks remain true.

### M2 provisioning regression

Receipt:

`docs/benchmarks/2026-09-30-wag-local-product-m4-m2-provision-regression.json`

Result: **PASS**.

The isolated first-time flow still reaches:

```text
run 1 -> ACTION_REQUIRED_CHATGPT_CONNECTOR
run 2 -> READY
```

and live WAG launcher/readiness checks remain unchanged.

## Source verification

Immediately before commit, refresh:

- `npm run test:wag-product`;
- `npx tsx --test test/cli.test.ts`;
- `npm run typecheck`;
- `npm run build`;
- `npm pack --dry-run`;
- `git diff --check`.

Final pre-commit verification:

- `npm run test:wag-product`: **33/33 PASS**;
- lifecycle core subset: **11/11 PASS**;
- `npx tsx --test test/cli.test.ts`: **10/10 PASS**;
- `npm run typecheck`: **PASS**;
- `npm run build`: **PASS**;
- `npm pack --dry-run`: **PASS** and includes `RELEASE.json`, release runtime modules and lifecycle scripts;
- `git diff --check`: **PASS**;
- M4 transactional fixture: **PASS**;
- M2 installer regression: **PASS**;
- M2 provisioning regression: **PASS**;
- unpacked tarball release payload hash: **MATCH**;
- dirty-development provenance is explicitly marked `+dirty:<payload-prefix>`;
- stable manifest generation from a dirty tree without explicit provenance: **REFUSED AS DESIGNED**.

## Legacy live-runtime adoption

The primary live WAG instance predates the M2/M3 managed release-state format and currently runs from
an external legacy runtime root. M4 now handles that upgrade boundary before the first transactional
update:

- if no release state exists, the updater requires the current local stack to be Ready;
- it snapshots the exact live WSL wrapper plus the three installed WAG launcher scripts;
- it records the current legacy CLI path and source revision in `WAG_LOCAL_LEGACY_BASELINE_V1`;
- it seeds `release-state.json` with a synthetic `legacy-<source-prefix>` active release;
- this adoption step does **not** restart or switch the live tunnel;
- a later failed M4 switch can restore the captured wrapper and launcher bytes, restart the exact WAG
  stack, and health-check the legacy baseline through the accepted local readiness endpoints.

This closes the rollback gap for dogfooding from the already-running pre-product WAG runtime without
pretending that the legacy runtime itself was originally installed by M4.

## Remaining M4 acceptance boundary

The transactional implementation plus legacy-baseline adoption are ready for committed-package
verification.

A first live dogfood attempt was rejected **before runtime switch** because Node's direct Windows
`spawnSync('npm.cmd', ...)` path returned `EINVAL`. The legacy baseline had already been adopted,
but the running WAG runtime, wrapper, tunnel, and supervisor remained unchanged. M4 now executes
Windows `.cmd` shims through PowerShell with arguments passed via `$args`, and a regression locks
that invocation path.

Full live acceptance still needs an explicitly disruptive dogfood operation:

1. package the committed candidate;
2. update the currently running WAG Local through the new lifecycle path;
3. reconnect ChatGPT if the tunnel restart terminates this session;
4. verify WAG health/tool round-trip and release state;
5. exercise rollback to the previous known-good runtime;
6. verify WAG health/tool round-trip again.

Live uninstall should **not** be required on the primary machine merely to prove deletion. The fixture
covers destructive deletion semantics. If a real uninstall acceptance is desired, use a disposable
install root/environment rather than intentionally removing the user's primary WAG connection.
