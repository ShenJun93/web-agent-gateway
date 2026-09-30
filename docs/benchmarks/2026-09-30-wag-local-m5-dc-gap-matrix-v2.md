# WAG Local M5 — Desktop Commander parity / gap matrix v2

Date: 2026-09-30  
Branch: `feat/wag-local-m5-dc-gap-matrix-v2`  
Base: `1baaf10229b72070f53ef54998ce0647dfa85d21` (M4 live lifecycle acceptance)

## Verdict

`M5_EVIDENCE_MATRIX = PASS`

`M5_GAPS_MEASURED_NOT_GUESSED = PASS`

`M6_AUTO_IMPLEMENTATION = NOT_AUTHORIZED_BY_SCORE_ALONE`

This matrix measures current WAG Local against current public Desktop Commander evidence after WAG
M1–M4 productization. It is an engineering prioritization artifact, not a product-ranking claim.

No Desktop Commander connector calls were made for this batch. Current official documentation and
recent public reliability reports were used for Desktop Commander evidence.

## Scoring

| Score | Meaning |
|---:|---|
| 0 | absent |
| 1 | partial or generic workaround only |
| 2 | usable but materially incomplete / externally unaccepted |
| 3 | strong/mature with a notable gap or current reliability caveat |
| 4 | strong and directly supported/accepted for the measured workflow |

A lower WAG score does **not** automatically authorize implementation. Every M6 promotion still needs
a blocked workflow, evidence, authority analysis, implementation cost, acceptance test and commercial
value.

## Evidence baseline

### WAG

- live connector currently exposes 53 MCP tools;
- M1: real Windows reboot/cold-start recovery accepted;
- M2: existing ChatGPT connector list/read workflow accepted; first-time external clean-user acceptance
  remains incomplete;
- M3: product doctor, failure matrix and bounded repair accepted;
- M4: transactional live update and explicit rollback accepted; uninstall deletion semantics accepted
  in isolated fixture;
- WAG also exposes specialized BrowserPort and reviewed repository/Git effect surfaces.

Canonical internal evidence:

- `docs/benchmarks/2026-09-30-wag-local-product-m1-local-destructive.md`
- `docs/benchmarks/2026-09-30-wag-local-product-m2-bootstrap-candidate.md`
- `docs/benchmarks/2026-09-30-wag-local-product-m3-doctor-candidate.md`
- `docs/benchmarks/2026-09-30-wag-local-product-m4-candidate.md`
- `docs/benchmarks/2026-09-30-wag-local-product-m4-live-acceptance.json`

### Desktop Commander

Current public docs checked on 2026-09-30 document:

- `npx ... setup`, several auto-update installation modes and explicit remove/uninstall;
- terminal/process sessions, output paging and process control;
- streaming search sessions with start/get-more/stop/list lifecycle;
- native Excel, PDF and DOCX operations;
- in-memory Python/Node/R;
- dynamic config get/set;
- usage stats, recent tool-call history and feedback;
- broad MCP client support;
- Remote MCP with OAuth device authorization, session persistence, device revoke and multi-device
  dashboard/control.

Current public Remote MCP issues also show recent OAuth/session reliability regressions. Those reports
are used only as a reliability caveat, not to generalize all Desktop Commander installations.

Public evidence:

- https://github.com/wonderwhy-er/DesktopCommanderMCP
- https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/README.md
- https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/src/remote-device/README.md
- https://github.com/desktop-commander/remote-desktop-commander
- recent Remote MCP reports: wonderwhy-er/DesktopCommanderMCP issues #600, #622 and #698

## Scored matrix

| Category | WAG | DC | Evidence-based interpretation |
|---|---:|---:|---|
| Local setup / first run | 2 | 4 | WAG one-command setup exists, but external clean-Windows acceptance is incomplete. DC documents mature npx/onboarding setup paths. |
| Manual steps to WebChat / remote first use | 2 | 3 | WAG first-time tunnel/runtime-key/connector path still crosses external account steps. DC remote also needs device OAuth plus AI connector OAuth. |
| Restart / reconnect recovery | 4 | 2 | WAG has measured reboot and injected-recovery evidence. DC documents persistence/reconnect but recent hosted OAuth/session regressions reduce current reliability confidence. |
| File read/write/move/delete | 4 | 4 | Both have strong local file operations; WAG additionally uses bounded/reviewed mutation surfaces. |
| Large-tree search lifecycle | 2 | 4 | WAG has search + continuation but no product-level cancel/list-active lifecycle. DC exposes start/get-more/stop/list search sessions. |
| Terminal/process lifecycle | 4 | 4 | Both are strong; WAG adds exact-identity revalidation for consequential process actions. |
| DOCX/XLSX/PDF workflows | 1 | 4 | WAG lacks native bounded DOCX/XLSX create/edit and rich PDF create/edit APIs. DC documents native support for all three. |
| Binary/media workflows | 3 | 4 | WAG supports images, PDF extraction and screenshots; DC has broader native preview/display coverage. |
| Bounded in-memory Python/Node/R | 1 | 4 | WAG has generic argv/process execution only; DC explicitly exposes in-memory execution. |
| Diagnostics / doctor | 4 | 3 | WAG M3 has stable diagnostics, failure mapping and bounded repair. DC has usage/history/debug/config diagnostics but no comparable published destructive matrix was found. |
| Update / rollback / uninstall | 4 | 3 | WAG M4 has staged acceptance, live health switch and explicit rollback. DC has convenient auto-update/remove but no documented transactional previous-version rollback equivalent. |
| Client breadth | 2 | 4 | WAG live acceptance is currently strongest for ChatGPT Web/private surfaces. DC documents many local MCP clients plus Remote MCP. |
| Remote device / multi-device management | 1 | 3 | WAG intentionally defers this to M7. DC has pairing, persistence, revoke and multi-device control, with current hosted reliability caveats. |
| Recovery from injected failures | 4 | 2 | WAG has measured M1/M3 injection evidence. DC public docs provide troubleshooting/reconnect behavior, not an equivalent accepted matrix. |
| Authority / secret containment | 4 | 2 | WAG uses bounded roots/effects and DPAPI runtime-secret handling. DC docs state allowedDirectories do not constrain terminal commands; Remote Device persistence on Windows does not set a custom owner-only ACL. |
| Effect/result correlation | 4 | 2 | WAG has durable effect/verify/mutation/result correlation. DC exposes useful local call history but no equivalent published durable consequential-effect model. |
| Configuration UX | 1 | 4 | WAG is mainly setup/config-file/doctor driven. DC exposes dynamic get/set config tools. |
| Recent activity / usage / feedback | 2 | 4 | WAG has diagnostics.recent/usage; DC additionally exposes product-level usage/history/feedback workflows. |
| Native browser automation | 4 | 1 | WAG has 7 BrowserPort tools. No comparable native browser harness appears in the documented DC core tool table. |
| Bounded repository/Git workflows | 4 | 2 | WAG has repository inspection, reviewed mutations, verify, commit and bounded remote push. DC can use terminal/files but does not document a comparable specialized Git effect surface. |

## What M5 says to build next

### P0 — Search lifecycle

**Blocked workflow:** very large or long-running searches cannot be listed/cancelled as owned product
sessions. Continuation exists, lifecycle control does not.

**Evidence:** Desktop Commander exposes `start_search`, `get_more_search_results`, `stop_search`
and `list_searches`; WAG exposes `machine.search` / `machine.search_continue`.

**Existing WAG alternative:** continuation tokens and generic process tools.

**Authority increase:** LOW.

**Implementation cost:** MEDIUM.

**Acceptance test:**

- start several large searches;
- list only active WAG-owned search jobs;
- cancel one deterministically;
- cancelled result tokens become invalid;
- no orphan worker/process/result buffer remains;
- pagination and result-size caps still hold.

**Commercial value:** HIGH.

### P0 — Native document operations

**Blocked workflow:** office/non-coding users cannot reliably inspect/create/edit XLSX and DOCX or
create/modify PDFs without format-specific shell/library glue.

**Evidence:** Desktop Commander documents native Excel/PDF/DOCX workflows; WAG currently has PDF
extraction, image read and generic execution.

**Existing WAG alternative:** external Python/Node libraries through generic command/process tools.

**Authority increase:** MEDIUM, but should remain file-mutation authority inside allowed roots.

**Implementation cost:** HIGH.

**Acceptance test:**

- format-specific round trips inside allowed roots;
- preserve formulas/styles/relationships where promised;
- atomic output writes;
- reject traversal, malformed archives, zip bombs and unsupported PDF structures;
- negative tests prove no authority outside allowed roots.

**Commercial value:** VERY HIGH.

### P1 — Product config / recent activity UX

**Blocked workflow:** users cannot inspect/update safe product settings or review recent activity
without config-file knowledge.

**Evidence:** DC exposes `get_config`, `set_config_value`, usage stats and recent tool calls. WAG has
doctor and diagnostics but not equivalent product UX APIs.

**Existing WAG alternative:** setup CLI, config files, `diagnostics.recent`, `diagnostics.usage`.

**Authority increase:** LOW.

**Implementation cost:** MEDIUM.

**Acceptance test:** schema-bounded keys, CAS writes, no secret disclosure, bounded pagination, unknown
keys fail closed.

**Commercial value:** HIGH.

### P1 — Update discovery

**Blocked workflow:** M4 can transactionally install a known release package, but product update
discovery/channel metadata remains unconfigured.

**Existing WAG alternative:** explicit package-root update.

**Authority increase:** LOW / network-read-only.

**Implementation cost:** MEDIUM.

**Acceptance test:** signed or pinned metadata, compatible release selection, deterministic offline
behavior, no automatic switch before M4 candidate acceptance.

**Commercial value:** HIGH.

### P2 — Bounded in-memory execution

**Blocked workflow:** short data transformations currently use generic process/argv execution and may
inherit more environment than necessary.

**Existing WAG alternative:** `machine.command.run`, process and terminal tools.

**Authority increase:** MEDIUM EXECUTION.

**Implementation cost:** MEDIUM.

**Acceptance test:** strict runtime/output/memory caps, explicit filesystem/network authority,
credential inheritance scrubbed, no surviving background children.

**Commercial value:** MEDIUM.

## Explicit deferrals

Do not pull these forward merely to match Desktop Commander:

- hosted multi-device management -> M7 architecture gate;
- broad commercial Remote service -> M7/M8;
- rich native file preview/editor -> M9 desktop experience;
- large batches of generic raw tools -> rejected until a measured workflow requires them.

## M5 decision

The strongest **local** gaps are not raw filesystem or terminal parity. WAG is already strong there.

The measured high-value deficits are:

1. search lifecycle control;
2. native office/document workflows;
3. product-level config/activity UX;
4. update discovery.

In-memory execution is useful but lower priority because WAG already has a generic execution
alternative and the dedicated capability increases execution surface.

Remote/device parity is a separate commercial architecture problem and stays behind M7 rather than
being smuggled into M6.

Therefore:

`M5_DC_PARITY_GAP_MATRIX_V2 = PASS`

`M6_CANDIDATE_SET = SEARCH_LIFECYCLE + DOCUMENT_OPS + PRODUCT_UX + UPDATE_DISCOVERY`
