# Trusted Adapter Admission Native-Host Refresh — 2026-09-16

Status: design-correction research receipt
Scope: interaction between Trusted Adapter Admission v1 and the accepted native-host distribution/installation identity

## Trigger

Trusted Adapter Admission v1 candidate `8bfd17928649e2c3bbaf2b20852342e9c9fd5227` passed its focused admission/security gate `44/44`, with zero skips and zero failures.

The first full repository verification on that exact SHA failed `npm test` with two failures in `test/native-host-installation-verifier.test.ts`. Typecheck, build, and Business were intentionally not run after the test failure. The candidate SHA remained unchanged.

The first failing fixture rebuilt `wag-native-host.exe` from current source and asserted that its SHA-256 still equaled the last accepted distribution executable hash. Current-source build evidence was:

- candidate SHA: `8bfd17928649e2c3bbaf2b20852342e9c9fd5227`;
- local candidate executable SHA-256: `4f0869078357cf8b8ae00e4d27adbef0b905921bdd5202aca38ca10c1b055ebb`;
- accepted historical executable SHA-256: `0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf`.

The local candidate hash is diagnostic evidence only. It is not an accepted distribution identity.

## Why the binary change is unavoidable

Admission v1 changes the native-host bundle inputs `src/browser-adapter/native-host.ts`, `native-host-main.ts`, and `local-link.ts`.

The old host opened a generic MCP link before browser correlation was known. Admission v1 instead requires `session.bind` to admit the exact browser correlation, receive a session-class bearer, and only then create the read-only MCP link. Keeping the old executable would therefore bypass the accepted admission architecture rather than preserve compatibility.

Rolling back those native-host changes is not a valid fix for the full-suite failure.

## Existing distribution and installation authority

Historical receipts remain true for their exact artifact:

- `NATIVE_HOST_DISTRIBUTION = PASS` for source `fd60c602dfe84ddf05b7e1575e77f45eb2c56b9d`;
- `NATIVE_HOST_INSTALLATION = PASS` for that same accepted source and executable hash `0349fbe41bc31c9685bd0f64431a517b34f600f614123d94582a47dc8e8a40cf`.

Those receipts must not be rewritten, invalidated retroactively, or silently pointed at the candidate binary.

The distribution contract permits a Task-10-consumable artifact only from a successful `push` workflow on exact reviewed `main` SHA. A feature-branch local build cannot supersede the accepted distribution identity.

## Corrected gate interpretation

The candidate needs a successor distribution/installation acceptance before Trusted Adapter Admission v1 can be declared PASS.

Use these states without rewriting historical receipts:

- historical distribution/install receipts remain `PASS` for `fd60c602...`;
- candidate compatibility state is `CURRENT_CANDIDATE_NATIVE_HOST_DISTRIBUTION = REACCEPT_REQUIRED`;
- source milestone may reach `TRUSTED_ADAPTER_ADMISSION_V1 = IMPLEMENTED_AWAITING_NATIVE_HOST_REFRESH` after source/security verification and review;
- final `TRUSTED_ADAPTER_ADMISSION_V1 = PASS` requires successor main-push distribution, installation reacceptance, and supported-host reacceptance for the admitted host.

Required release sequence:

`source candidate -> source verification/review -> merge main -> main-push distribution artifact -> verify successor receipt -> prepare successor installation -> separately authorized registration switch -> read-only installation verification -> supported-host reacceptance -> admission PASS`.

No local build hash is promoted into production constants before the main-push distribution receipt exists.

## Full-suite test correction

The installation verifier regression tests currently use a rebuild of current native-host source as a surrogate for the historical accepted executable. That assumption is only valid while native-host bundle inputs are unchanged.

The tests should instead exercise verifier behavior with a hermetic synthetic fixture and a temporary verifier copy whose expected executable hash is replaced only for that test fixture. The committed production verifier and accepted installation constants remain unchanged. Static/AST safety checks continue to inspect the committed production verifier.

This separates two questions that must not be conflated:

1. does verifier logic still fail closed and classify owned installation state correctly? — repository regression test;
2. has the new native-host binary obtained accepted release provenance and installation state? — successor distribution/installation gate after merge.

## Authority boundary

This correction authorizes no registry mutation, cleanup, browser mutation, terminal/Git authority, or replacement of the installed host.

The later registration switch remains an explicit operational checkpoint. If successor distribution, installation verification, or supported-host evidence fails, admission remains fail-closed and does not fall back to the old generic-MCP trust path.

## Research conclusion

Proceed with the two-phase refresh correction. Do not roll back bind-time admission and do not promote a local executable hash. Amend ADR-0017, the admission design, and its implementation plan before changing verifier-test behavior.

## Successor acceptance metadata sequencing

The successor workflow run id, attempt, and executable hash do not exist until the feature source is merged and the `main` push workflow completes. They therefore cannot truthfully be committed into the feature branch in advance.

After that artifact is verified, a narrow follow-up reacceptance change may update the accepted distribution/install constants, production read-only verifier pins, and successor receipt to the observed artifact identity. That follow-up must not modify native-host bundle inputs; otherwise it creates a new executable requiring another distribution decision.

The artifact remains bound to the exact feature-merge `main` SHA that produced it. The later metadata commit records acceptance of that already-produced artifact; it does not claim that a feature-branch or metadata-commit rebuild supplied the accepted bytes.
