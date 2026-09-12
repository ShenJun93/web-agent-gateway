# File patch mutation spike gate receipt

Date: 2026-09-12
Candidate SHA (split-TTL local gate): `0bb0cf3adad1a13fad2b5adc82bab21d3c32f949`
Historical browser evidence implementation SHA (pre-split): `19ff33c42c30c81cad313d4107410b5056ce9813`
Fresh split-TTL browser attempt implementation SHA: `0bb0cf3adad1a13fad2b5adc82bab21d3c32f949`
DevSpace revision: `33d6d0bcc2256024484d2456da924af8afd814ed`
DevSpace package observed at runtime: `@waishnav/devspace@1.0.8`
Protocol: MCP `2026-07-28`

## Repository verification

Executed from the isolated `feat/file-patch-spike` worktree, in the required order:

1. `npm test` — PASS; 64 passed, 0 failed, 0 skipped.
2. `npm run typecheck` — PASS.
3. `npm run build` — PASS.
4. `npm run test:business` — PASS; 1 passed, 0 failed, 0 skipped.
5. `git diff --check` — PASS.

The suite includes pending/approved split-TTL approval state-machine tests, approval single-use/fingerprint checks, stale-target rejection, path containment, binary/size bounds, exact-match uniqueness including overlapping occurrences, LF and CRLF mutation, donor metadata validation, post-write SHA verification, default five-tool regression, and the local browser-spike approval parser.

After the historical browser evidence was collected, hardening added explicit rejection of an `update` entry carrying `previousPath`, rejection of `.` / `./` paths that normalize to an empty relative path, and rejection of overlapping `before` occurrences. ADR-0009 then split the approval timing into a 60-second pending-preview window and a separate 60-second approved-use window beginning at first successful local approval. The full local gate above was rerun on the split-TTL candidate SHA.

## Surface and scope evidence

Default MCP and Business stdio remain exactly five tools: `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`. `file.patch` appears only when explicitly enabled and is the sixth tool. Its schema does not accept raw patch text and its annotations mark it destructive and non-idempotent.

The browser spike uses a process-memory `PatchApprovalStore` and a local stdin approval command. The production build and default Business stdio path do not expose mutation approval state or enable `file.patch`.

## Browser adapter fixture

The disposable SuperAssistant adapter started from readonly patched hash `970f41fb1b360b607a49981a5652ac206bd962a1e0cc9cf5ecf2f254c53bf6f0`.

For mutation transport only, the disposable unpacked adapter was changed to default to the loopback Streamable HTTP auth proxy; resulting hash: `f5a9dd536469fea9cf4c56e8870cd671b5914b139d68ed41e675e53589f9d9a9`. This artifact is outside the Gateway repository and is not production code.

The disposable Git fixture began clean with `note.txt` equal to `alpha\nbeta\ngamma\n`, SHA-256 `4fdbc441ea7b546100e086ac1e4fc5ae6749b7314311c99db05be450eca12996`.

## ChatGPT browser evidence

Real browser execution history proved the six-tool mutation Gateway was reachable:

- call 92 `health` — PASS: `status=ok`, executor `devspace`, protocol `2026-07-28`, `toolCount=6`;
- call 94 `workspace.open` — PASS on the disposable fixture;
- call 95 `file.read` — PASS and returned the expected three-line content;
- calls 96, 97, and 99 `file.patch` preview — PASS and returned `approval_required`, fingerprint `f89d98691aa50529cd305e158c55575728bea46fc9b73d52fd0f537f4810df03`, and result SHA-256 `d20d1f2bb8a0d3fa3aac8373135c10de759b9f9c4a8075d33b14a96c160c945e`.

Local terminal approval returned `approved` for fresh preview requests, but ChatGPT host latency exceeded the required 60-second approval TTL before apply executed. Calls 98 and 100 therefore failed closed with `Gateway denied patch approval`. No DevSpace mutation occurred from either apply attempt.

A SuperAssistant `Re-execute` action generated a fresh preview approval through the extension MCP client. Harmless browser call 150 executed `health` successfully through that same client. Diagnostic call 151 was rejected by the `file.patch` schema before mutation because the cloned function block retained stale apply-only state. These diagnostics prove browser-extension MCP execution but do not satisfy the required mutation acceptance sequence.

A later retest switched ChatGPT to `Instant` while the sidebar showed `Server Connected` and `6 of 6 tools enabled`. Browser execution history then recorded call 160 `file.read`, followed by call 161 `file.read` on the same fresh workspace used by the mutation attempts; call 161 again returned the expected three-line file. Calls 162 and 163 performed fresh `file.patch` previews for that workspace and returned `approval_required`. The local approval command for call 163 returned `approved`, but call 164 `file.patch` apply was recorded 66.717 seconds after call 163. The approval expiry was 60 seconds, so call 164 reached Gateway about 6.752 seconds after expiry and correctly failed with `Gateway denied patch approval`.

Switching the host to `Instant` therefore did not make the supported ChatGPT host path complete preview-to-apply inside the fixed TTL. Static inspection of the disposable SuperAssistant bundle showed its MCP client is exposed only inside the content-script isolated world and tool calls cross its internal background ContextBridge; no supported page-level tool-call bridge was available. The adapter was not patched to manufacture a faster acceptance path.

At the end of the ChatGPT attempts the disposable file still had the original SHA-256 and the disposable Git fixture remained clean. There is no successful browser mutation/read-back/snapshot evidence to claim.

## Gemini browser evidence

A genuinely visible Gemini tab was reloaded against the same disposable mutation Gateway and showed `Server Connected` with `6 of 6 tools enabled`. The SuperAssistant function block for call 201 `workspace.open` was executed with its visible `Run` control and appeared in Gemini execution history. Gemini then used the actual function result from call 201 to issue call 202 `file.read` for `note.txt`; call 202 was recorded in extension execution history with that returned workspace binding. Before destructive preview call 203 could be submitted, the browser-control environment blocked the automation request at its own safety boundary. No Gemini preview/apply call was sent after that block, and no Gemini mutation result is claimed.

## Fresh split-TTL browser attempt

ADR-0009 was accepted and implemented on candidate `0bb0cf3adad1a13fad2b5adc82bab21d3c32f949`. A fresh disposable harness was started from that exact worktree implementation and the disposable fixture was reset to the original clean three-line file. The first DevSpace readiness attempt hit the known transient startup timeout; retrying the unchanged harness succeeded. A fresh loopback auth proxy was then started.

The existing Edge browser was attached through the official Playwright Extension consent flow, selecting the intended Gemini tab. The visible SuperAssistant sidebar then showed `Server Connected`, `MCP Settings - Active`, and `6 of 6 tools enabled`. The historical Gemini conversation still exposed supported `workspace.open` and `file.read` function blocks and their prior execution history.

Before a fresh split-TTL `workspace.open -> file.read -> file.patch preview -> local approval -> file.patch apply -> file.read -> repo.snapshot` sequence could be completed, the browser-control environment began blocking ordinary UI activation commands at its own safety boundary. The attempt stopped there rather than switching to a synthetic MCP call path or bypassing the host-control restriction. No split-TTL mutation call was sent and no successful browser mutation is claimed from this attempt.

## Approval timing and safety result

The historical single-clock trace measured 66.717 seconds from preview execution to apply execution, while apply arrived only about 37 seconds after local approval. ADR-0009 addresses exactly that distinction without lengthening mutation authority: pending preview remains valid for 60 seconds, and first successful exact local approval starts a separate 60-second approved-use window. Re-approval does not extend that window.

Local controller tests prove apply may occur after the preview deadline when first approval happened before that deadline and the approved-use deadline is still live; apply fails at or after the approved-use deadline. Browser acceptance must still demonstrate the same behavior through a supported host.

No production approval endpoint, persistent approval, wildcard approval, raw patch input, file creation/deletion/move, or Business mutation enablement was added. Default and Business surfaces remain non-mutation five-tool surfaces.

## Gate result

`LOCAL_FILE_PATCH_SPIKE = PASS`

`CHATGPT_BROWSER_MUTATION = INCOMPLETE_FAIL_CLOSED`

`GEMINI_BROWSER_MUTATION = NOT_COMPLETED`

`BUSINESS_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

`MUTATION_SCOPE = SPIKE_ONLY`

The implementation is locally verified, but Task 6 Step 2 is not satisfied because no supported host completed the required `preview → local approval → apply → read-back → repo.snapshot` sequence. This receipt does not authorize merge of mutation capability into the default or Business production surface.
