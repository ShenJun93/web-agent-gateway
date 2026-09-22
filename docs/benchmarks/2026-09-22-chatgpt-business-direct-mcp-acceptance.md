# ChatGPT Business Direct MCP Acceptance

Date: 2026-09-22
Branch: `feat/goal-ui-delegation-v1`
Accepted implementation base before main reconciliation: `756131165f044ce2835fd1d01356c0dfae89d654`
Reconciled branch head at start of this receipt: `e1e91e6`

## Result

CHATGPT_BUSINESS_DIRECT_MCP_TRANSPORT       = PASS
CHATGPT_DIRECT_HEALTH_E2E                   = PASS
CHATGPT_DIRECT_WORKSPACE_OPEN_E2E           = PASS
CHATGPT_DIRECT_REPO_SNAPSHOT_E2E            = PASS
CHATGPT_DIRECT_REPO_SEARCH_E2E              = PASS
CHATGPT_DIRECT_FILE_READ_E2E                = PASS
CHATGPT_DIRECT_MUTATION_PREVIEW_E2E         = PASS
CHATGPT_DIRECT_PREVIEW_NO_APPLY             = PASS

CHATGPT_DIRECT_READ_E2E                     = PASS
CHATGPT_DIRECT_PROPOSAL_E2E                 = PASS
CHATGPT_DIRECT_DURABLE_WRITE_EFFECT_E2E     = NOT_YET_PROVEN
CHATGPT_DIRECT_VERIFY_E2E                   = NOT_YET_PROVEN
CHATGPT_DIRECT_GIT_COMMIT_E2E               = NOT_YET_PROVEN
CHATGPT_DIRECT_AUTONOMOUS_LEASE_E2E         = NOT_YET_PROVEN

This closes the provider-side blocker recorded by ADR-0030 for the part actually
observed. It does not promote an unobserved write, verify, commit, or autonomous
lease path to PASS.

## Live topology

ChatGPT Business
  -> WAG Local developer-mode draft app
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client v0.0.14 under WSL2 Ubuntu
  -> WAG private stdio surface
  -> Windows Node
  -> DevSpace

The Windows tunnel-client binary was not used because Windows Smart App Control
blocked the unsigned client. Smart App Control was not disabled. The official
Linux tunnel-client under WSL2 was used instead.

The WAG app remained a draft and was not published.

No runtime API key or owner token is recorded in this receipt.

## Local tunnel readiness

tunnel-client doctor       PASS
/healthz                   live
/readyz                    ready
/ui                        HTTP 200
tunnel-client processes    1
WAG stdio children         1

The stdio child was the expected built WAG CLI with the local acceptance config.

## Direct ChatGPT observations

health returned:

status          = ok
executor        = devspace
protocolVersion = 2026-07-28
toolCount       = 6

The observed `toolCount = 6` is the DevSpace executor contract count returned by
WAG health, not the ChatGPT-facing WAG MCP tool inventory. WAG health validates
DevSpace `tools/list` against the six required internal DevSpace operations, so
this observation proves:

DEVSPACE_EXECUTOR_TOOL_CONTRACT = 6 / PASS
CHATGPT_WAG_MCP_SURFACE_COUNT   = NOT_MEASURED

The thirteen-tool extended profile remains a locally projected and tested WAG
surface. This health result does not establish how many WAG tools the live
Business connector exposed.

The calls were executed in this order:

health
workspace.open
repo.snapshot
repo.search
file.read
mutation.preview
repo.snapshot

workspace.open successfully opened:

E:/AI-BROWSER/wag-acceptance/workspace

repo.snapshot observed branch `work` at:

1c1297e863aab46ae2bfd69e7419e4d499bf4311

The first snapshot exposed pre-existing acceptance-fixture residue in the Git
index and one untracked CONTRIBUTING.md. Read-only reconciliation established
that README.md and ticket-id.test.js matched HEAD after restoring only their
index entries. The untracked acceptance residue was then removed manually.
The acceptance workspace finished clean.

repo.search found `ticket-id.js`.

file.read returned:

    export function ticketId(raw) {
      return String(raw).trim().toUpperCase();
    }

Its SHA-256 was:

247c0a24a0a58318f6ad8fd9704b70bdee9a601a1a01c97eeadc12c15ae728c7

mutation.preview proposed the null-safe form and returned
`status=approval_required`, with the same base SHA-256 and a distinct result
SHA-256.

The following repo.snapshot was equivalent in Git state to the snapshot
immediately before the preview. ticket-id.js did not become dirty. Therefore
the direct provider path proved proposal creation without applying the proposal.

The mutation was not approved.

## What this proves

ChatGPT Business can call WAG directly through Secure MCP Tunnel and consume
structured MCP results without DOM observation, fenced wag-tool relay,
Desktop Commander, or another model acting as transport intermediary.

The observed path covers direct repository discovery/read and creation of a
bounded mutation proposal.

## What this does not prove

This receipt does not claim:

- a mutation was approved or applied through ChatGPT;
- mutation.result was exercised;
- verify.run was exercised;
- git.commit or git.commit.result was exercised;
- a Goal Lease admitted a ChatGPT-originated action;
- ChatGPT provider confirmation can be suppressed by WAG;
- the thirteen-tool extended configuration was exposed by this live connector;
- the developer-mode app is ready to publish.

Those require separate live evidence.

## Repository reconciliation

Before this receipt, origin/main was reconciled into the local feature branch.

The merge had no path overlap between the two sides, completed with the ort
strategy, left the worktree clean, and produced:

HEAD...origin/main = 43 ahead / 0 behind
git diff --check   = clean

No push, PR, publish, release, registry, signing, or provider mutation is
authorized by this receipt.

## Post-reconciliation verification

After recording the live provider acceptance, the reconciled branch passed:

npm run test:business
  1 pass, 0 fail

npm run test:dc-replacement
  1 pass, 0 fail

npx tsx --test test/direct-mcp-readiness.test.ts
  8 pass, 0 fail

npx tsx --test test/direct-mcp-session-binding.test.ts
  8 pass, 0 fail

npm run typecheck
  PASS

npm run build
  PASS

npm test
  882 tests
  876 pass
  0 fail
  6 todo
  exit success

git diff --check
  PASS

The six TODO cases are existing open harness-guard residuals. They are reported
by Node under the failing-tests heading because the TODO assertions currently
demonstrate the known gaps, but the suite records them as TODO and reports
fail=0.

No source, runtime, configuration, dependency, workflow, tunnel, provider, or
authority change was made by this acceptance receipt.
