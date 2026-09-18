# Contributing to Web Agent Gateway

Web Agent Gateway is a least-authority local capability gateway. Changes that widen authority, trust boundaries, mutation surfaces, credential handling, native-host trust, or release/signing behavior require explicit design and acceptance evidence.

## Before opening a change

- Keep the change as small and reversible as practical.
- Do not include secrets, credentials, private repository material, machine-specific private configuration, or user data.
- Do not weaken existing fail-closed validation to make a test, signer, browser, or provider pass.
- Prefer semantic capabilities over generic shell/process/browser mutation.
- Treat Git history, approved specs, ADRs, tests, CI, and live evidence as stronger authority than chat or informal notes.

## External pull requests

Changes proposed by non-committers require maintainer review before merge.

The current maintainer/reviewer is `ShenJun93`.

Review includes build scripts and CI configuration when they can affect release artifacts or code-signing provenance.

## Verification

For ordinary source changes, run the relevant focused tests plus:

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

For Windows native-host or signing-readiness changes, also run:

```powershell
npm run verify:native-host-licenses
```

and the focused native-host distribution/candidate tests documented by the relevant approved design.

## Security reports

Do not put sensitive vulnerability details in a public issue. Follow `SECURITY.md`.

## Code signing

Changes to native-host build inputs, signing policy, CI signing integration, artifact configuration, or release provenance require review against `docs/policies/code-signing-policy.md`.
