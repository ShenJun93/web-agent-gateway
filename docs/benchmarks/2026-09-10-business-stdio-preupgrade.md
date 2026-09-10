# Business stdio pre-upgrade receipt

Date: 2026-09-10
Candidate SHA: `968217f7fb1c9a9ec3d923127ba6b5e6b02bd9a7`
DevSpace revision: `33d6d0bcc2256024484d2456da924af8afd814ed`
Node: `v24.20.0`
npm: `12.0.2`

## Exact-candidate gate

Executed from a clean worktree at the candidate SHA, in this order:

1. `npm ci` — PASS; 100 packages installed, 0 vulnerabilities. npm reported that the `esbuild@0.28.2` postinstall was blocked by the local `allowScripts` policy; this did not block tests or build.
2. `npm test` — PASS; 41 passed, 0 failed, 0 skipped.
3. `npm run typecheck` — PASS.
4. `npm run build` — PASS.
5. `npm run test:business` — PASS; 1 passed, 0 failed, 0 skipped.
6. `git diff --check` — PASS.
7. Post-check — PASS; worktree clean and HEAD unchanged at the candidate SHA.

## Business stdio acceptance evidence

- Exact-pinned DevSpace started on loopback using revision `33d6d0bcc2256024484d2456da924af8afd814ed`.
- Built stdio Gateway exposed exactly five tools: `health`, `workspace.open`, `repo.snapshot`, `file.read`, `verify.run`.
- Real stdio calls completed `workspace.open`, bounded `file.read`, and configured `verify.run` successfully.
- OAuth access-token TTL was forced to 1 second and refresh-token TTL to 60 seconds; repeated health calls across refresh boundaries passed, exercising rotated refresh tokens.
- Gateway stderr contained sanitized ready/telemetry events and did not contain the test owner token or workspace root.
- First Gateway stdio child exited after client close; a second built Gateway process re-bootstrapped OAuth and returned healthy, then also exited cleanly.
- Built `doctor` exited 0 with JSON status `ok`; running without the owner token exited non-zero with stable `DEVSPACE_OWNER_TOKEN_MISSING` diagnostics and no token/path disclosure.

## Secret and process-leak checks

A raw literal-prefix scan finds expected documentation/policy strings in the implementation plan/spec and the deliberate empty Windows scrub command `DEVSPACE_OAUTH_OWNER_TOKEN=` in source. Those are not credential values.

A value-aware tracked-file scan checked for non-placeholder owner/control-plane assignments, credential-shaped `sk-proj-` and `github_pat_` values, and private-key headers. Result: **0 credential-shaped secret hits**.

Post-acceptance process scan result:

- Gateway `serve-stdio` matches: 0.
- DevSpace `dist/cli.js serve` matches: 0.

## Gate result

`LOCAL_BUSINESS_STDIO_READINESS = PASS`

`CHATGPT_BUSINESS_END_TO_END = NOT_YET_TESTED`

`BUSINESS_PURCHASE_RECOMMENDATION = ALLOWED_FOR_EXTERNAL_ACCEPTANCE_ONLY`

This receipt proves only the local pre-upgrade path. ChatGPT Business effectiveness remains unverified until the post-upgrade Secure MCP Tunnel acceptance passes.