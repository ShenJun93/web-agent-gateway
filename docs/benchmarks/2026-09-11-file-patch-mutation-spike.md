# File patch mutation spike gate receipt

Date: 2026-09-12
Candidate SHA (local gate): `6269541722389a090566adb7336a820ca9a696a8`
Browser evidence implementation SHA: `19ff33c42c30c81cad313d4107410b5056ce9813`
DevSpace revision: `33d6d0bcc2256024484d2456da924af8afd814ed`
DevSpace package observed at runtime: `@waishnav/devspace@1.0.8`
Protocol: MCP `2026-07-28`

## Repository verification

Executed from the isolated `feat/file-patch-spike` worktree, in the required order:

1. `npm test` — PASS; 61 passed, 0 failed, 0 skipped.
2. `npm run typecheck` — PASS.
3. `npm run build` — PASS.
4. `npm run test:business` — PASS; 1 passed, 0 failed, 0 skipped.
5. `git diff --check` — PASS.

The suite includes approval TTL/single-use/fingerprint checks, stale-target rejection, path containment, binary/size bounds, exact-match uniqueness including overlapping occurrences, LF and CRLF mutation, donor metadata validation, post-write SHA verification, default five-tool regression, and the local browser-spike approval parser.

After browser evidence was collected, hardening added explicit rejection of an `update` entry carrying `previousPath`, rejection of `.` / `./` paths that normalize to an empty relative path, and rejection of overlapping `before` occurrences; the full local gate above was rerun on the candidate SHA.

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

At the end of the ChatGPT attempts the disposable file still had the original SHA-256 and the disposable Git fixture remained clean. There is no successful browser mutation/read-back/snapshot evidence to claim.

## Gemini browser evidence

A visible Gemini tab connected to the same disposable mutation Gateway and discovered/enabled 6 of 6 tools through the loopback Streamable HTTP auth proxy. The full mutation sequence was not run because the plan requires ChatGPT first and the ChatGPT mutation gate had not passed. Later UI automation was unavailable, so no Gemini mutation result is claimed.

## Approval friction and safety result

The 60-second TTL is explicitly required by the approved design and was not relaxed for acceptance. Browser/model latency can exceed that window, so approval can expire before an apply call reaches Gateway. The observed behavior was fail-closed: expired approvals never mutated the target, and stale requests required a fresh preview and local approval.

No production approval endpoint, persistent approval, wildcard approval, raw patch input, file creation/deletion/move, or Business mutation enablement was added to work around the host limitation.

## Gate result

`LOCAL_FILE_PATCH_SPIKE = PASS`

`CHATGPT_BROWSER_MUTATION = INCOMPLETE_FAIL_CLOSED`

`GEMINI_BROWSER_MUTATION = NOT_COMPLETED`

`BUSINESS_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

`MUTATION_SCOPE = SPIKE_ONLY`

The implementation is locally verified, but Task 6 Step 2 is not satisfied because no supported host completed the required `preview → local approval → apply → read-back → repo.snapshot` sequence. This receipt does not authorize merge of mutation capability into the default or Business production surface.
