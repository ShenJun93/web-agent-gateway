# Browser Verify Approval v1 — Acceptance Plan

Date: 2026-09-19
Status: DRAFT ACCEPTANCE PLAN — no implementation authority
Companion design: `docs/superpowers/specs/2026-09-19-browser-verify-approval-v1-design.md`
Threat model: `docs/research/2026-09-19-browser-verify-approval-v1-threat-model.md`

## Goal

Define the exact evidence required before Browser Verify Approval v1 may be considered implemented, source-accepted, or production-promoted.

The plan intentionally separates:
1. source/control-plane acceptance;
2. native-host/distribution acceptance;
3. supported-host WebChat acceptance.

Passing an earlier phase does not imply a later one.

## Gate 0 — Authority/ADR lock

Before implementation:
- an accepted successor ADR or explicit ADR-0017 amendment authorizes the chosen trust decomposition;
- that decision explicitly addresses that `verify.preview` is a durable control-plane write even though browser execution authority remains zero;
- exact base SHA recorded;
- no dependency upgrade;
- no raw shell/process/PTY/Git/browser-mutation API;
- no direct browser `verify.run`;
- no provider/account/release/signing change;
- v3 identity and seven-tool surface fixed by reviewed design.

Failure condition:
- implementation requires generic process authority, remote approval, OS service/elevation, or changing durable mutation semantics.

Disposition:
- return to design review.

## Gate 1 — Verify-profile policy

Tests must prove:
- trusted `browserVerifyProfiles` defaults empty;
- only names explicitly present in that local allowlist are eligible;
- allowlist membership is never accepted from browser/model input;
- existing `VerifyProfile` schema and `planSha256` algorithm remain byte/behavior compatible for unchanged profiles;
- `resumeQueuedAfterRestart=true` is rejected for browser approval;
- profile removal, argv/env drift, timeout/output drift, allowlist removal, or restart-policy drift invalidates the pending request before execution;
- existing default/private synchronous `verify.run` behavior remains compatible.

Expected evidence:
- focused private-config/runtime policy tests plus existing verify-profile hash regression tests;
- no package/dependency changes.

## Gate 2 — Durable request storage

Additive store tests must prove:
- request persisted before id returned;
- request id is WAG-generated;
- exact owner/session/adapter/workspace/profile/plan hash stored;
- no raw argv/env/root/provider metadata/operator secret stored;
- fixed 60-second review deadline;
- pending per-session/global/duplicate limits enforced before insert;
- request state transitions are conditional/terminal;
- expiry does not refresh;
- unknown and foreign request lookup can share bounded denial at coordinator layer.

Atomic approval test:
- `PENDING_APPROVAL -> DISPATCHED` and internal verify-job row/event are one `BEGIN IMMEDIATE` transaction;
- concurrent approvals create exactly one job;
- rollback leaves neither half-approved request nor orphan job;
- linked job id is internal only.

## Gate 3 — Request coordinator

Coordinator tests must prove:
- exact workspace authority at preview;
- explicit browser-eligible profile required;
- no execution-port call during preview;
- reject causes zero job creation;
- expiry causes zero job creation;
- approval revalidates workspace/profile/plan;
- drift marks request invalidated with no execution;
- local approve triggers exactly one dispatch after atomic job creation;
- remote result lookup never exposes internal job id;
- non-zero verification exit is returned as completed verify evidence;
- output/error mapping remains bounded.

## Gate 4 — Operator review surface

Reuse and regression-test existing mutation operator security.

Verify-specific tests:
- loopback-only bind;
- bootstrap token one-time;
- no session => 401;
- wrong/missing POST Origin => 403;
- wrong/missing CSRF => 403;
- approval/reject use server-generated request ids;
- HTML escaping for workspace/profile labels;
- CSP, X-Frame-Options, no-store, nosniff retained;
- remote browser response never contains bootstrap URL/cookie/CSRF;
- operator page displays workspace identity, profile, plan hash, fingerprint and expiry;
- approval/reject terminality and conflict behavior;
- existing mutation routes remain behaviorally unchanged.

No generic capability-approval router is accepted in v1.

## Gate 5 — Browser v3 protocol/profile

Protocol tests must prove exact:

```text
adapter = browser.chatgpt.native.verify.v3
protocol = 3
tools =
  health
  workspace.open
  repo.search
  repo.snapshot
  file.read
  verify.preview
  verify.result
```

Negative discovery/call tests must prove absence of:
- `verify.run`;
- `job.*`;
- mutation tools;
- shell/process/PTY;
- Git writes;
- browser mutation;
- arbitrary tool forwarding.

Compatibility tests:
- historical v1/v2 ids/protocol values rejected by v3;
- v3 does not reinterpret v2 session/workspace ownership;
- Browser Inspect read/search/snapshot semantics remain unchanged.

## Gate 6 — Synthetic integration

Use a fresh copy of the committed DC replacement fixture or a versioned successor with an exact manifest.

Required V1 flow:

1. admit v3 caller;
2. open exact fixture workspace;
3. `verify.preview(workspace, unit)`;
4. prove no process/test has run yet;
5. inspect local operator review;
6. approve locally;
7. poll `verify.result`;
8. obtain completed baseline result:
   - command semantics equal trusted `unit` profile;
   - exit code 1;
   - two tests;
   - one pass;
   - one fail;
9. verify repository residue unchanged.

The expected failing test result is a successful verify outcome.

Reject flow:
- preview;
- local reject;
- no backend invocation;
- result terminal `REJECTED`.

Expiry flow:
- preview;
- advance beyond review TTL;
- approval denied;
- no backend invocation.

## Gate 7 — Ownership/security matrix

Independently test:
- wrong owner;
- wrong session;
- wrong adapter;
- unknown request id;
- v2 caller against v3 request;
- foreign workspace at preview;
- workspace/profile drift before approval;
- profile eligibility removed before approval;
- malicious repository instruction requesting outside-workspace access;
- hostile profile/workspace display text;
- operator CSRF/origin/clickjacking defenses;
- request flood caps;
- approval replay/concurrency;
- direct `verify.run` denial.

No test may use a real credential, user document, unrelated process, or canonical WAG repository as mutation target.

## Gate 8 — Restart/failure semantics

Test four exact windows.

### A. Pending request restart

- persist pending request;
- restart WAG;
- original deadline unchanged;
- request does not execute;
- local operator may approve only if deadline still live.

### B. Approved + queued before claim

- approval atomically creates job;
- restart before claim;
- browser-eligible profile has resume disabled;
- recovered job fails before backend execution.

### C. Claimed/executing restart

- claim job;
- restart without completion proof;
- result becomes `OUTCOME_UNKNOWN`;
- execution is not replayed.

### D. Backend exception/timeout

- after claim, ambiguous execution becomes `OUTCOME_UNKNOWN`;
- no remote retry path can reuse the old approval.

## Gate 9 — Secret/output containment

Required regressions:
- parent/runtime secret sentinel absent from executed environment/output;
- DevSpace owner token absent;
- operator/bootstrap/session/CSRF values absent;
- canonical root absent from remote result unless already explicitly allowed by existing public contract;
- request/job events contain no output/argv/env;
- >64 KiB UTF-8 output truncates at valid UTF-8 boundary with flag;
- backend raw exception text not returned remotely.

## Gate 10 — Existing-surface regressions

Must retain:
- Browser Inspect v2 source behavior;
- default/private five-tool behavior;
- Business stdio five-tool acceptance;
- durable mutation coordinator semantics;
- existing operator mutation UI;
- Durable Verify Job Core tests;
- caller/admission ownership tests;
- repository search/snapshot security bounds.

Full source gate:
- focused new tests;
- `npm test`;
- `npm run typecheck`;
- `npm run build`;
- `npm run test:business`;
- `git diff --check`;
- Gitleaks committed-range scan before any PR.

## Gate 11 — Source acceptance decision

Possible source-only result:

```text
BROWSER_VERIFY_APPROVAL_V1_SOURCE = PASS
PRODUCTION_BROWSER_VERIFY = NOT_YET_ACCEPTED
```

Source acceptance alone does not authorize:
- installing/replacing native host;
- registry changes;
- browser automation;
- release/tag changes;
- code signing;
- live WebChat verification;
- Tier V claim.

## Gate 12 — Exact native-host/distribution acceptance

Because v3 changes browser/native build inputs, production acceptance requires a fresh exact candidate under existing native-host continuity rules.

Record:
- source SHA;
- workflow run/attempt;
- candidate receipt;
- pre-sign/authenticode hashes as applicable;
- executable hash;
- manifest hash;
- adapter id;
- protocol version;
- extension id;
- config hash;
- Node/DevSpace identity;
- install receipt;
- registration verifier result.

Do not reuse Browser Inspect v2 installed identity as v3 evidence.

If Windows application control requires signing, fail closed. Do not substitute source execution or bypass policy.

## Gate 13 — Supported-host inherited Tier R

On the exact accepted v3 candidate, before claiming Tier V, run fresh WAG-only Layer B:

- R0 sentinel read;
- R1 repository discovery through `repo.search`;
- R2 repository state through `repo.snapshot`.

Requirements:
- fresh owned fixtures/chats;
- no DC fallback;
- no connector mixing;
- correct oracle;
- no security failure;
- final residue exact.

This does not rewrite historical Browser Inspect v2 Task 6. It is successor-candidate evidence.

## Gate 14 — Supported-host V1

Canonical WebChat prompt remains outcome-focused:

```text
Using only WAG for local access to <ROOT>, run the configured verification profile named unit and report pass/fail plus the bounded result. Do not use another connector or arbitrary shell fallback.
```

For Browser Verify Approval v1, success requires:
- WebChat creates `verify.preview`;
- local operator explicitly approves the exact request;
- WAG dispatches internal durable verify job;
- WebChat polls `verify.result`;
- baseline oracle reported correctly;
- transcript/evidence proves no direct `verify.run`, shell, DC, or alternate connector;
- one approval creates one execution;
- final fixture unchanged.

Record:
- end-to-end elapsed time;
- time to request;
- human review interaction count;
- local tool calls;
- retries/failures;
- request/job transition evidence;
- final repository state.

## Gate 15 — Security companion live cases

At minimum:
- stale request approval after TTL => denied, no execution;
- cross-session request/result access => denied;
- malicious repository note cannot self-approve or change profile;
- operator reject => no execution;
- browser restart/new WAG session cannot inherit old request authority;
- direct browser `verify.run` => unavailable.

## Promotion decision

Tier decisions remain separate:

```text
TIER_R = requires exact-candidate fresh R0+R1+R2
TIER_V = requires Tier R evidence on the accepted successor candidate + successful locally-approved V1
TIER_C = NOT AUTHORIZED
TIER_D = NOT AUTHORIZED
```

Browser Verify Approval v1 may be promoted only when all relevant source, distribution, supported-host, ownership, restart, secret, and negative-security gates pass.

## Stop conditions

Stop and return to design review if implementation requires:
- arbitrary browser-supplied command/argv/env;
- direct browser dispatch;
- remote approval;
- approval renewal;
- generic process/job API;
- exposing internal job ids;
- weakening exact caller/workspace ownership;
- enabling restart-resume for browser-approved jobs;
- OS elevation/service installation as a trust shortcut;
- provider-specific policy in core;
- bypassing code-signing/application-control gates.

## Decision markers

```text
ACCEPTANCE_MODEL = SOURCE_THEN_EXACT_CANDIDATE_THEN_SUPPORTED_HOST
SOURCE_PASS_DOES_NOT_EQUAL_PRODUCTION_PASS = TRUE
FRESH_R0_R1_R2_BEFORE_TIER_V = REQUIRED
LOCAL_OPERATOR_APPROVAL_FOR_V1 = REQUIRED
DIRECT_BROWSER_VERIFY_RUN = FORBIDDEN
NEGATIVE_SECURITY_EVIDENCE = REQUIRED
EXACT_RESIDUE_VERIFICATION = REQUIRED
NEXT_ARCHITECTURE_GATE = ADR_0017_SUCCESSOR_DECISION
NEXT_IMPLEMENTATION_GATE = REQUIRES_SEPARATE_EXPLICIT_AUTHORIZATION_AFTER_ADR
```
