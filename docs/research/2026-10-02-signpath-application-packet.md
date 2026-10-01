# SignPath application packet — 2026-10-02

Status: PREPARED / NOT SUBMITTED

This packet contains only deterministic project fields and truthful draft answers. It does not fill
personal identity fields and does not accept any provider terms or data-processing consent.

## Deterministic project fields

- Project Name: `Web Agent Gateway`
- Repository URL: `https://github.com/ShenJun93/web-agent-gateway`
- Homepage URL: `https://github.com/ShenJun93/web-agent-gateway`
- Privacy Policy URL:
  `https://github.com/ShenJun93/web-agent-gateway/blob/main/docs/policies/privacy.md`
- Maintainer Type: `Individual maintainer(s)`
- Build System: `GitHub Actions`

Download/release evidence:

- immutable unsigned preview:
  `https://github.com/ShenJun93/web-agent-gateway/releases/tag/v0.1.0-preview.1`
- release tag target: `c1eb195f54864dee1a8997c9baeb0475ce627da6`
- current main: `4645aeef1edd21b6193b31029b74a94f85ee0438`

The preview URL is valid released-form evidence but its binary is not the current-main signing
candidate.

## Tagline draft

> Local least-authority gateway connecting Web AI clients to user-approved developer resources.

## Description draft

> Web Agent Gateway (WAG) is an open-source local trust and capability gateway for AI clients that
> need bounded access to user-approved development resources. WAG keeps identity, workspace
> ownership, secrets and authority under a local policy layer while exposing semantic MCP tools for
> repository inspection, bounded file changes, Git operations, browser automation and related
> developer workflows. The Windows native-host path is built and verified through GitHub Actions
> with source-controlled provenance and explicit security boundaries.

## Reputation draft

> Web Agent Gateway is a newly public open-source project with an immutable Windows preview release,
> public Apache-2.0 source, documented security/privacy/code-signing policies, GitHub Actions build
> provenance, and verifiable release evidence. We do not claim broad external adoption at this
> stage. The repository currently reports one star, but we have not established that it is an
> independent trust signal, and the existing release download counter includes maintainer
> verification traffic. We are providing the public repository and release evidence for SignPath
> Foundation to assess whether the project's current verifiable history is sufficient.

This is disclosure, not a claim of broad reputation.

## What should be signed

- artifact: `wag-native-host.exe`
- platform: Windows x64
- artifact type: PE executable / Authenticode
- product version line: `0.1.0`
- runtime model: Node.js Single Executable Application
- requested signature: SHA-256 Authenticode
- certificate requirement: RSA code-signing certificate chaining to a Windows-trusted public root
- timestamp: required
- every signing request: manual approval required

## Current-main build evidence

Source:
`4645aeef1edd21b6193b31029b74a94f85ee0438`

GitHub Actions:
- workflow: `Native Host Distribution`
- run: `36916880632` / run number `107`
- conclusion: `SUCCESS`

Current unexpired evidence:
- signing-input artifact ID `11190685060`
- candidate-evidence artifact ID `11189244843`
- verified distribution artifact ID `11189624852`

The old `preview.1` candidate at `c1eb195f` is not continuous with current main because multiple
`NATIVE_HOST_BUILD_INPUTS` changed.

## Provider question — Node SEA

> WAG uses Node's documented Single Executable Application flow: we copy the official pinned Node
> executable, remove its original signature, inject the WAG SEA blob, apply WAG-specific VERSIONINFO,
> and preserve applicable Node and bundled-component license notices. WAG does not modify or fork
> Node source. Does SignPath Foundation consider this resulting application executable to be WAG's
> own binary for signing, or does the Foundation's modified-upstream visible-fork condition apply to
> this packaging model?

Treat SignPath's project-specific answer as provider authority.

## Fields that remain operator-only

Do not auto-fill or infer:

- First Name
- Last Name
- Email
- Company Name, if applicable
- Primary Discovery Channel
- exact discovery source, if requested
- Code-of-Conduct agreement
- personal-data-processing consent
- optional marketing consent

## Submission state

```text
APPLICATION_PACKET = PREPARED
APPLICATION_SUBMITTED = NO
TERMS_ACCEPTED_BY_AGENT = NO
PERSONAL_DATA_CONSENT_ACCEPTED_BY_AGENT = NO
SIGNING_REQUEST_SUBMITTED = NO
```