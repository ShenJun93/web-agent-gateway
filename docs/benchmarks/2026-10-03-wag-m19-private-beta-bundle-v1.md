# WAG M19 — Private Beta Bundle v1

Date: 2026-10-03
Branch: feat/wag-m19-private-beta-bundle-v1
Base: public main b0da407ce5a9598608bafc806907a05d075566ef

## Objective

Produce one reproducible, integrity-checked Windows private-beta bundle for external testers of the current full WAG product, without weakening Windows security controls or embedding maintainer credentials.

## Added

- `scripts/package-private-beta-bundle.ts`
  - packages only from a clean exact committed HEAD;
  - derives release id `<version>-beta-<12hex-source>`;
  - runs the existing release-aware `npm pack`;
  - embeds the exact-source browser extension with regenerated release identity;
  - emits `PRIVATE_BETA_BUNDLE.json`;
  - uses the deterministic ZIP helper;
  - refuses overwrite, symlinks, unsupported entries, and credential/tunnel-client payload paths.
- `scripts/wag-private-beta-install.ps1`
  - Windows + PowerShell 7 only;
  - verify-only mode;
  - verifies package SHA/size;
  - verifies every extension file SHA/size and rejects extra files;
  - recomputes and verifies extension tree SHA before binding it into the runtime marker;
  - never disables Defender, SmartScreen, Smart App Control, execution policy, or enterprise controls;
  - never accepts/ships maintainer tunnel credentials or tunnel-client binary;
  - uses the M15 clean-install acceptance flow.
- `docs/private-beta/windows-private-beta.md`
  - tester install/reboot/connector-proof workflow;
  - unsigned-beta warning and explicit stop-on-policy-block guidance.
- `docs/private-beta/operator-runbook.md`
  - 5-completed-install evidence target;
  - privacy-safe tester coordination;
  - explicit receipt consent and offline aggregation rules.
- `test/private-beta-bundle.test.ts`
  - exact-source release id contract;
  - bundle manifest fail-closed validation;
  - real PowerShell `-VerifyOnly` fixture;
  - file tamper and extension-tree tamper rejection.
- npm script: `beta:bundle`.

## Acceptance before exact bundle packaging

- TypeScript typecheck: PASS.
- Build: PASS.
- M19 targeted tests: 3/3 PASS.
- Full `test:wag-product`: 85/85 PASS.
- Private beta installer PowerShell parse: PASS.
- `git diff --check`: PASS.

## Exact bundle packaging acceptance

The packager intentionally refuses a dirty worktree. That release gate was exercised on committed M19 code HEAD:

`490b6a6c65fb9e402666e9c7b61a4930986d1708`

Two independent bundle runs produced the same release identity and exact hashes:

- release id: `0.1.0-beta-490b6a6c65fb`
- outer ZIP SHA-256: `1132fce70bad45d5d278441daa967a4d7d8f44264bd06ad105eb7c126430dab1`
- npm package SHA-256: `058454a9ae42b10083b9d467feaf050611aa4bfe10a0ced16e9f0e1db8f27725`
- extension tree SHA-256: `e394804ceeb88b36b349fe1118a952ba3d16073c02e1a7a5130499db3196b217`
- ZIP entries: 48
- forbidden secret/tunnel-client payload paths: 0
- bundled `INSTALL-WAG-BETA.ps1 -VerifyOnly`: PASS

The live release gate exposed and closed two implementation defects before acceptance:

1. direct Node `spawnSync('npm.cmd', ...)` failed on Windows; the packager now uses the established PowerShell argv-JSON command-shim path;
2. locale collation disagreed with the deterministic ZIP helper's ordinal ordering; packager and installer extension-tree hashing now use canonical ordinal ordering.

Post-fix acceptance:

- TypeScript typecheck: PASS.
- Build: PASS.
- M19 targeted tests: 3/3 PASS.
- Full `test:wag-product`: 85/85 PASS.
- Private beta installer PowerShell parse: PASS.
- `git diff --check`: PASS.

This evidence update itself changes the Git source SHA, so any distributed beta ZIP must be rebuilt from the final published source/merge commit. The final distribution SHA belongs in the external release/handoff record rather than creating an infinite evidence-commit/repackage loop.

No public push, PR, merge, or live promotion is claimed by this document yet.
