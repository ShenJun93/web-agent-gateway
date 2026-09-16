# Native Host Release Reacceptance v1 Acceptance Receipt

Date: 2026-09-16
Repository base: `4dcabd0a33de9b2a0685512fd3ab982e657edb0e`
Implementation commit: `656f4279b5ea290437cddddf7227c45d61b97631`
Branch: `feat/native-host-release-reacceptance-v1`

## Goal

Refresh the exact accepted native-host release identity to the current verified main-push artifact without changing installation schema, native application identity, extension identity, registry semantics, Browser Admission authority, or runtime tool surfaces.

This milestone changes source/tests/documentation only. It does not install the successor artifact and does not mutate the Windows registry.

## Accepted artifact provenance

- source SHA: `4dcabd0a33de9b2a0685512fd3ab982e657edb0e`
- workflow run: `35088504189`, attempt `1`
- artifact id: `10442509226`
- artifact name: `wag-native-host-windows-x64-4dcabd0a33de9b2a0685512fd3ab982e657edb0e-attempt-1`
- artifact digest: `sha256:cd9a3438a7e70755eae7244fcc5d84d41a2e947e6d2483e5cd3e1b681e4173e3`
- executable SHA256: `62af695a2d8bd219b940c207b4edb7d18f1bc0c3c3cd7f549f35ace407aaf138`
- Node: `24.20.0`
- package-lock SHA256: `0763378ab7a9c124b7f701b9e54c516bc4208d5197e4d4d13d1beb18e096a6e3`
- native application: `com.openai.web_agent_gateway`
- extension id: `nnhhhppkpogkedpjnijeagcbfjaoogec`
## TDD and reacceptance evidence

RED was observed before the policy refresh: `test/native-host-installation.test.ts` expected the current release identity while production still pinned Task 9C/9D, and the accepted source SHA assertion failed on `9c7fb288...` versus `4dcabd0...`.

GREEN changed only the accepted source SHA, executable SHA256, workflow run id, the committed PowerShell verifier pins, and the exact-pin regression assertions.

The downloaded workflow artifact passed the current distribution verifier. The updated installer prepared it into a fake `LOCALAPPDATA`, and the updated read-only verifier accepted its bytes and manifest while reporting `registration = DRIFT`, as expected because the real registry remained pointed at the older installed Task 9C/9D host.

Behavioral acceptance of the exact downloaded executable passed the current Browser/native path, including framed messaging, Browser Admission, exact three browser tools, health, workspace open/read, reconnect, session isolation, and Windows ADS/path denial.

## Verification evidence

- `npm run typecheck` - PASS
- installation/verifier focused suite - PASS, 24/24
- current-artifact Browser/native acceptance - PASS, 13/13
- `npm run build` - PASS
- `npm run test:business` - PASS, 1/1
- `npm test` - PASS, 193/193; fail 0; skipped 0
- `git diff --check` - PASS
- `git diff --exit-code -- package.json package-lock.json` - PASS

The predecessor installed host remained untouched and continued to verify as registration `MATCH` during the preceding release-coherence spike.
## Decision

`NATIVE_HOST_RELEASE_REACCEPTANCE_V1 = PASS`

`ACCEPTED_NATIVE_HOST_SOURCE_SHA = 4dcabd0a33de9b2a0685512fd3ab982e657edb0e`

`ACCEPTED_NATIVE_HOST_EXECUTABLE_SHA256 = 62af695a2d8bd219b940c207b4edb7d18f1bc0c3c3cd7f549f35ace407aaf138`

`ACCEPTED_NATIVE_HOST_WORKFLOW_RUN = 35088504189`

`INSTALLED_HOST_MUTATION = NONE`

`REGISTRY_MUTATION = NONE`

`INSTALLATION_SCHEMA_CHANGE = NONE`

`AUTHORITY_WIDENING = NONE`

`NEXT_GATE = SUCCESSOR_INSTALLATION_AND_REGISTRATION`
