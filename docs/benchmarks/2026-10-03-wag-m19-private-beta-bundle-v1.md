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

## Release gate still to run after commit

The packager intentionally refuses a dirty worktree. After this milestone is committed:
1. package two ZIPs from the exact committed M19 HEAD;
2. prove identical outer ZIP SHA-256;
3. extract one ZIP;
4. run the bundled `INSTALL-WAG-BETA.ps1 -VerifyOnly`;
5. record exact bundle/package/extension SHA evidence.

No public push, PR, merge, or live promotion is claimed by this document yet.
