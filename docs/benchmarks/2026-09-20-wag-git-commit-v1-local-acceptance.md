# WAG Git Commit v1 — Local Production Acceptance Receipt

Date: 2026-09-20
Status: PASS — local production acceptance only
Candidate: `489715b`
Base: `1aeb953`
Predecessor receipt: `docs/benchmarks/2026-09-19-wag-dc-replacement-v1-local-acceptance.md`
Design: `docs/superpowers/specs/2026-09-19-wag-dc-replacement-v1-design.md`
Acceptance plan: `docs/superpowers/plans/2026-09-19-wag-dc-replacement-v1-acceptance.md`
Decision authority: ADR-0018, ADR-0020, ADR-0021, ADR-0022, ADR-0023

This is a successor, not an amendment. The predecessor receipt stands as written for `1aeb953`.

## Scope of this receipt

Local production acceptance only. It does not claim, authorize or substitute for:

- push, PR, merge, release, tag or version change;
- code signing or native-host candidate publication;
- any provider or account action;
- any Layer B WebChat tier claim under the DC Replacement Workflow Benchmark v1 contract;
- Tier C or Tier D on any browser surface.

Under the benchmark contract this is Layer A production evidence.

## Environment

```text
host                = Microsoft Windows 11 Pro 10.0.26200, x64
node                = v24.20.0
npm                 = 12.0.2
git                 = 2.55.0.windows.2
devspace pin        = docs/benchmarks/devspace-pin.json
gitleaks            = 8.30.1
```

## Commits in range

```text
5eb9ccd  docs: decide reviewed committing through git plumbing
489715b  feat: commit through a private index behind local review
```

## What changed

One new reviewed authority class on the private/Business stdio surface, off unless the local config asks for it.

```text
src/git-commit.ts                      DurableCommitCoordinator: propose, local approval, one CAS commit
src/git-commit-backend.ts              the backend contract (plan / commit)
src/executor/devspace-git-commit.ts    the plumbing helper and its DevSpace execution
src/durable-store.ts                   new `commits` table; no migration, no new column on an old table
src/operator-server.ts                 commit review and approval routes; bidi-safe rendering
src/server.ts                          git.commit and git.commit.result behind an explicit switch
src/private-config.ts                  repositoryEngineering.gitCommit, requires mutation
src/repository-engineering-runtime.ts  assembly, reconcile-before-serve, teardown
src/path-policy.ts                     a missing read target no longer discloses the canonical root
```

Surface with all three flags configured, in exactly this order:

```text
health  workspace.open  repo.list  repo.search  repo.snapshot  repo.diff  file.read  verify.run
mutation.preview  file.create  mutation.result  git.commit  git.commit.result
```

The shipped default remains exactly five tools. Business acceptance is unchanged.

## Gates

```text
npm test                     401 pass / 0 fail   exit 0   522.2s
npm run typecheck                                exit 0
npm run build                                    exit 0
npm run test:business        1 pass / 0 fail     exit 0
npm run test:dc-replacement  1 pass / 0 fail     exit 0
git diff --check                                 exit 0
gitleaks 8.30.1  1aeb953..HEAD   2 commits, 131.15 KB, 0 leaks, exit 0
```

`npm test` includes 26 commit tests in `test/git-commit.test.ts`, each against a real pinned DevSpace and a
repository built to be hostile: hooks of eleven classes installed in both `.git/hooks` and a `core.hooksPath`
pointing into the worktree, a dirty real index, unrelated dirty files, and awkward filenames.

## Production-local evidence

Built `dist/cli.js serve-stdio` spawned as a real child process over a real stdio MCP transport, against the real
pinned DevSpace and a fresh copy of the committed fixture, with every approval performed over the real loopback
operator HTTP server — real bootstrap redemption, real session cookie, real CSRF token, real Origin check.

```json
{"acceptance":"WAG_DC_REPLACEMENT_V1_PRODUCTION_LOCAL",
 "tools":["health","workspace.open","repo.list","repo.search","repo.snapshot","repo.diff","file.read","verify.run",
          "mutation.preview","file.create","mutation.result","git.commit","git.commit.result"],
 "fixtureHead":"b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d",
 "fixtureTree":"e276f7b0d6ea9e606ac9c3683e27781d354f8ce9",
 "baselineExitCode":1,"afterFixExitCode":0,"operatorApprovals":3,
 "createdFile":"test/ticket-id.extra.test.js",
 "commitBranch":"wag-work",
 "commitSha":"568a0aaca9195bb0c72a5150eba5edc1d65df345",
 "commitParent":"b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d",
 "commitClassHooksFired":false,"backendHookInvocations":18,
 "finalStatus":["MM src/lib/ticket-id.js","D  test/ticket-id.extra.test.js",
                "?? test/ticket-id.extra.test.js","?? unrelated-dirty.txt"]}
```

Verified in that run, in order:

- committing to `main` was refused before anything else, because `main` is protected by default;
- eleven hook classes were armed in `.git/hooks` **and** in a hostile `core.hooksPath`, and the canary was cleared
  immediately before the WAG operation;
- exactly one commit was created, with exactly one parent — the previewed HEAD — and the tree the preview bound;
- the commit contains exactly the two approved paths and their exact contents;
- the message, which contains `$(touch pwned)`, was stored verbatim and created no file;
- **no commit-class hook fired at all**;
- the real index tree hash was byte-identical before and after;
- the unrelated dirty file was still `?? unrelated-dirty.txt`;
- the DevSpace owner token appeared nowhere in the gateway's diagnostics.

### Hook attribution, stated exactly

`commitClassHooksFired: false` is the load-bearing claim: no `pre-commit`, `prepare-commit-msg`, `commit-msg` or
`post-commit` hook ran, from either location, for either half of the operation.

`backendHookInvocations: 18` is `post-index-change` and `reference-transaction`, and they are **not** WAG's. Opening a
workspace is the execution backend's own MCP operation, it writes its own review refs, and WAG cannot pass git options
into that call. A dedicated attribution test in `test/git-commit.test.ts` proves those two classes fire from
`executor.openWorkspace()` alone, with no WAG git invocation involved. WAG's own invocations all carry
`-c core.hooksPath=<empty directory>` and run nothing. This is recorded rather than claimed away.

### The index consequence

`MM` and `D ` in the final status are the documented, tested consequence of never touching the operator's real index
(ADR-0023). The commit, the worktree and every unrelated staged change are exactly as intended; the index still holds
the pre-commit tree until the operator refreshes it with `git reset -- <paths>`, which changes no file content.

## Independent security review

A second independent adversarial review was run against the working tree before acceptance, with authority to build
throwaway repositories and drive the real helper source directly. It reported one HIGH, five MEDIUM and six LOW, and
seventeen attacks that failed. Every finding was reproduced or re-derived here before being acted on.

| # | Finding | Disposition |
| --- | --- | --- |
| H1 | A repository's `core.worktree` redirects `git add` at any directory; every per-path guard inspects a decoy while the commit carries the outside file's bytes | **Fixed.** Reproduced first. Regression test. |
| M2 | A workspace nested in a larger repository commits to the **outer** repository's branch | **Fixed** by the same assertion. Reproduced. Regression test. |
| M3 | An executor error or interrupted helper was recorded as `FAILED` although the commit may have landed | **Fixed.** Those outcomes are `OUTCOME_UNKNOWN`. Regression test. |
| M4 | The review page never said which repository the commit was for | **Fixed.** Repository and author are rendered. Regression test. |
| M5 | Bidi overrides and zero-width characters reached the review page verbatim, in paths, the change set and the message | **Fixed.** Rendered as visible code points. Regression test. |
| M6 | Only the helper was gzipped, so an 8 KiB message failed past `cmd.exe`'s limit as an opaque `UNKNOWN`; the ADR claimed otherwise | **Fixed.** Payload gzipped, command measured, refused at proposal with a named reason. Regression test. |
| L7 | The ADR claimed the path policy was re-checked at approval; it was not | **Fixed.** `validatePaths` now runs in `approveLocal`. |
| L8 | Author identity was unchecked, came from untrusted config, and was never shown | **Fixed.** Bound, displayed, revalidated. Regression test. |
| L9 | The change set from the backend was stored and rendered unvalidated host-side | **Fixed.** Validated in `preview`. |
| L10 | No cap on outstanding proposals; the operator's finite list could be buried | **Fixed.** Eight per caller. Regression test. Row pruning deferred and documented. |
| L11 | A filename containing the executor's truncation marker blocked its own preview forever | **Fixed.** Only pre-sentinel framing is scanned. |
| L12 | The ADR overstated the `commits` row as a transition log | **Fixed.** Wording corrected; the audit-log gap is now listed as not accepted. |

H1 and M2 shared one root cause: per-path confinement asked whether a path was inside the root and never whether the
git repository *was* the root. Both are closed by asserting `git rev-parse --show-toplevel` against the admitted
canonical root, with both sides resolved through the native realpath first.

### Negative evidence — attacks that failed

`commit.gpgsign` with a hostile `gpg.program`; `diff.external` and a `.gitattributes` diff driver; protected-branch
bypass through a symref (`symbolic-ref --quiet` resolves to the terminal ref, which is load-bearing and now says so in
a comment); `.git/HEAD` refname traversal; Windows 8.3 short-name bypass of the sensitive-path policy; a symlinked
selected path escaping the workspace; a nested inner repository under a selected path; `check-attr` parse confusion;
macro attributes and `.git/info/attributes`; a `.gitignore`d selected path; forging the `__WAG_BEGIN__` result
sentinel from the commit message; executor output truncation hiding a change; `cmd.exe` silently truncating an
over-long command (it refuses instead); shell or argv injection through the message or paths; double approval,
replay and expired approval; cross-origin and CSRF approval; SQL injection or id smuggling; and information
disclosure of absolute paths, tokens or `statePath` through any error path.

## What v1 still does not do

```text
amend, merge commits, empty commits, signing, force, reset, clean, checkout/switch
branch creation or deletion, arbitrary ref update, push / fetch / pull
committing on a detached HEAD
committing to a protected branch
implicit add . / -A / unrestricted staging
committing a deletion or a rename
a repository using a `filter` attribute on a selected path
an append-only transition log for commits, and pruning of terminal commit rows
```

## Acceptance decision

```text
WAG_GIT_COMMIT_V1_LOCAL = PASS
TIER_G_LOCAL = one reviewed commit complete with real local operator approval
COMMIT_CLASS_HOOK_EXECUTION = NONE_OBSERVED
REAL_INDEX_AND_WORKTREE = PRESERVED
INDEPENDENT_SECURITY_REVIEW = COMPLETED_AND_REMEDIATED
```

Not authorized and not claimed by this receipt: push, PR, merge, remote branch mutation, release, tag, signing, any
provider or account action, any machine-wide change, and any Layer B WebChat result.
