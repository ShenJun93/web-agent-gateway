# Trusted Caller Context v1 Acceptance Receipt

Date: 2026-09-15
Candidate SHA: `969c4f22e73d2747f925e496821c1a29388c7696`
Design base SHA: `b1e725feef09a459666295f2e023c4399580b2ab`
Branch: `docs/trusted-caller-context-v1-design`
Spec: `docs/superpowers/specs/2026-09-15-trusted-caller-context-v1-design.md`
ADR: `docs/adr/0015-use-trusted-caller-context.md`
Plan: `docs/superpowers/plans/2026-09-15-trusted-caller-context-v1.md`

## Candidate scope

The candidate introduces one provider-neutral WAG-owned caller-context contract and makes durable mutation consume it. Authority-bearing fields are `ownerId`, `sessionId`, and `adapterId`; optional correlation metadata is non-authoritative.

Production/runtime files changed for this milestone:

- `src/caller-context.ts`;
- `src/durable-store.ts`;
- `src/durable-mutation.ts`;
- `src/server.ts`;
- `scripts/durable-mutation-browser-spike.ts`.

The prerequisite harness-only change raised the pinned DevSpace test startup default from 15 seconds to 30 seconds in `test/devspace-fixture.ts`, with lifecycle regression coverage. It changes no production runtime behavior or authority.

## Caller-context contract evidence

`createGatewayCallerContext(value: unknown)` validates a strict object and returns a frozen copy. The exact accepted authority bounds are:

- `ownerId`, `sessionId`, `adapterId`: 1-128 ASCII characters matching `^[A-Za-z0-9._:-]+$`;
- `correlation.provider`: optional, 1-64 characters using the same safe character set;
- `correlation.clientId`: optional, 1-128 characters using the same safe character set;
- `correlation.conversationRef`: optional, at most 512 UTF-8 bytes and no C0 control characters or NUL;
- unknown outer and nested correlation keys are rejected.

Both the returned context and nested correlation object are frozen. `test/caller-context.test.ts` proves valid construction, outer and nested immutability, missing-field rejection, every exact v1 upper bound, over-bound rejection, unsafe characters, C0/NUL rejection, and unknown-key rejection.

`GatewayAuthority` is derived from `GatewayCallerContext` as only the three authority fields. `MutationCaller` is retained only as `type MutationCaller = GatewayCallerContext`; there is no second mutation-specific identity shape.

## Persistence and authority evidence

`src/durable-store.ts` replaced the standalone identity interface with `GatewayAuthority` on workspace/mutation record types. Git diff inspection found no `CREATE TABLE`, `ALTER TABLE`, SQL column, row-value, or state-machine changes.

Correlation has no persisted field or database handling. Durable identity comparison remains exactly owner/session/adapter; correlation does not participate in authorization or durable lookup semantics.

`test/durable-mutation.test.ts` independently changes each of `ownerId`, `sessionId`, and `adapterId` and requires `Gateway denied mutation identity` for every mismatch. Existing file-backed restart/reconciliation tests continue to pass, proving that persisted records remain readable and mutation lifecycle semantics are unchanged.

## Tool and trust-boundary evidence

The trusted context is injected by runtime composition as `MutationMcpContext.callerContext`; it is not accepted from tool arguments. The opt-in `mutation.preview` and `mutation.result` schemas remain strict and contain no authority or correlation fields.

`test/mcp-surface.test.ts` proves that authority/correlation names are absent from model-visible mutation schemas and that an attempted `owner_id` injection returns an MCP tool error before the handler can use it.

Default MCP remains exactly five tools: `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`. Business stdio acceptance remains the same five-tool path. The opt-in durable mutation surface still adds only `mutation.preview` and `mutation.result`.

Browser Adapter v1 remains exactly `health`, `workspace.open`, and `file.read`. Browser production code was not changed. Regression coverage rejects ownership/correlation-like extra arguments, and the browser protocol `sessionId` was not promoted into WAG durable authority.

No private-config, OAuth, task-store, package manifest/lockfile, browser runtime/extension, or native-host production file changed in the candidate. No new environment variable, discovery field, or model-facing identity parameter was introduced.

## Exact-candidate verification

Focused contract gate on candidate `969c4f22e73d2747f925e496821c1a29388c7696`:

`npx tsx --test test/caller-context.test.ts test/durable-store.test.ts test/durable-mutation.test.ts test/durable-mutation.acceptance.test.ts test/durable-mutation-runtime.test.ts test/mcp-surface.test.ts test/http-transport.test.ts test/browser-adapter-protocol.test.ts`

Result: PASS — 26 passed, 0 failed, 0 skipped.

Fresh full repository gate on the same candidate:

- `npm test` — PASS: 169 passed, 0 failed, 0 skipped;
- `npm run typecheck` — PASS, exit 0;
- `npm run build` — PASS, exit 0;
- `npm run test:business` — PASS: 1 passed, 0 failed, 0 skipped;
- `git diff --check` — PASS, exit 0.

Git scope inspection from design base `b1e725f` to candidate `969c4f2` found no changed browser extension/runtime/native-host production file, private-config/OAuth module, `src/task-store.ts`, package manifest, or lockfile. The durable-store diff contains TypeScript authority import/extends changes only and no SQL-change tokens.

## Independent review

A separate read-only reviewer inspected the exact base-to-candidate diff against the accepted spec, ADR, and Tasks 1-3.

Disposition:

- Critical: 0;
- Important: 0;
- Minor: 2, non-blocking;
- `INDEPENDENT_REVIEW = PASS`.

Minor notes: `test/durable-mutation-runtime.test.ts` still injects a structurally trusted raw caller literal rather than exercising the factory on that historical runtime path; the accepted spec permits explicit trusted test/runtime composition. The tracked implementation plan is intentionally retained as project history.

No review finding required a code or test change, so the prior exact-candidate verification remains applicable without rerun.

## Acceptance conditions

1. Shared validated immutable caller-context implementation — PASS.
2. Durable mutation uses the shared contract instead of a mutation-specific identity definition — PASS.
3. Exact owner/session/adapter mismatch tests fail closed — PASS.
4. Model-visible tool schemas cannot choose or override authority identity — PASS.
5. Default, Business, and browser tool surfaces remain unchanged — PASS.
6. No durable-store schema migration or persisted mutation semantic change — PASS.
7. Full repository verification passes with no new authority or cleanup behavior — PASS.

## Gate result

`TRUSTED_CALLER_CONTEXT_V1 = PASS`

This gate authorizes only later reviewed milestones to consume the shared caller-context contract. It does not authorize durable generic jobs, browser mutation projection, production Business mutation, per-tab/session ownership admission, shell or persistent PTY access, Git writes, generic process/browser managers, an MCP SDK upgrade, or any widening of cleanup authority.
