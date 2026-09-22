# A delegated Run produced a leased effect, end to end

2026-09-22. Branch `feat/goal-ui-delegation-v1`. The chain from an untrusted page's text to a
durable effect, with no human gesture at either gate, is now demonstrated in production rather than
in a fixture.

## The chain, as durable rows

```text
run_authority
  proposal_id    prop_e8ab2e132a664f35b6e0e444
  authority      DELEGATED_RUN
  goal_id        goal_delegated_run_mubsstqa
  delegation_id  uidel_d919f3f60522bb3b71f05e22
  controller_id  local.operator.cli
  tool           mutation.preview
  workspace_id   ws_ac7c8384-abd7-4103-9ce4-5d100d70b422
  session_id     session_648f30ad-03ac-4473-afda-ec2bc93a2d62
  adapter_id     browser.chatgpt.native.delegation.v5
  origin         https://chatgpt.com
  result_id      res_53fad728d83e7909ee5e7baaa368cfc6

mutation_authority
  mutation_id    mut_9c51408d-a6c5-47ca-9d4b-8ad68f179b68
  authority      POLICY_APPROVED
  lease_id       lease_mubsstqa_5e468457
  workspace_id   ws_ac7c8384-abd7-4103-9ce4-5d100d70b422
  path           README.md
  result_sha256  55aa5e6d0afd9bc66882c689c43c184924b128fc91965373d41770f92ce78e3a
  diff_bytes     229

mutations       state SUCCEEDED   +4 / -1   base 9dbb1fde…  result 55aa5e6d…
```

`result_id` is populated, which is the difference from every previous attempt. The two authorities
are distinguishable by record: the Run was `DELEGATED_RUN` under the delegation, the effect was
`POLICY_APPROVED` under the lease, and neither is `HUMAN_RUN` or `HUMAN_APPROVED`.

## The effect, as bytes

`README.md` on disk is 256 bytes and hashes to `55aa5e6d0afd9bc66882c689c43c184924b128fc91965373d41770f92ce78e3a`
— byte-identical to the `result_sha256` WAG recorded. The file was 101 bytes before.

## Replay protection, proven by production rather than by a test

The content script observed the same assistant message three times as it streamed, and staged three
proposals with the **identical** WAG-computed fingerprint:

```text
prop_e8ab2e132a664f35b6e0e444  RESULTED  fp_f792a09b15478…   <- claimed, ran, produced the effect
prop_c335292a37d07b1a237a1326  STAGED    fp_f792a09b15478…   <- PROPOSAL_REPLAY, slot_claimed=0
prop_3574562b1efa617ea626895f  STAGED    fp_f792a09b15478…   <- PROPOSAL_REPLAY, slot_claimed=0

delegation_claims for this delegation: 1
mutations in this workspace:           1
```

One claim, one effect, two refusals that spent nothing. This is the durable guarantee — the CLAIM
transaction — not the extension's local suppression memory, and it was not arranged: three
observations of one message is what the page produced on its own.

**This run says nothing about the extension's own suppression-cache idempotence.** One cache entry
was deliberately released earlier in the session under explicit operator authorisation, so that
property was not under test here and is not claimed.

## Restart and recovery

The gateway was stopped and restarted between the two snapshots below — processes enumerated from
the process table rather than read from a pid file, because a stale pid file is exactly what caused
an earlier failure in this mission.

```text
                          before            after
claims                    1                 1
proposal states           RESULTED=1        RESULTED=1
                          STAGED=2          STAGED=2
run authority             DELEGATED_RUN     DELEGATED_RUN
                          result=res_53f…   result=res_53f…
mutation state            SUCCEEDED         SUCCEEDED
mutation authority        POLICY_APPROVED   POLICY_APPROVED
mutations in workspace    1                 1
refusals                  2 × slot=0        2 × slot=0
README.md sha256          55aa5e6d…         55aa5e6d…
README.md bytes           256               256
```

Identical. Nothing re-ran, no slot was returned or re-spent, and the two `STAGED` rows stayed
`STAGED` rather than becoming eligible again.

## Verify

The configured `unit` profile (`node --test ticket-id.test.js`) runs green against the mutated tree:
1 test, 1 pass, exit 0. This is the profile the live config declares; it is a local execution of
that argv, not a WAG verify job.

## The blocker this run found and fixed

The activation instrument required "exactly one fresh v5 session". A single extension reload minted
**three** fresh sessions within two minutes — one per browser context — and a session's age never
resets, because re-admitting with the same correlation returns the same row. The rule could not be
satisfied by waiting, reconnecting, or anything an operator could do.

It now requires `--session` to be the **newest** fresh session, which enforces the property the rule
was protecting — never bind a grant to a context the browser is not using — without an
unsatisfiable precondition. A genuine same-millisecond tie still refuses. Two tests cover it:
`with several fresh sessions, the newest is accepted` and `a fresh session that is not the newest is
still refused`.

## Gates

```text
npm test                     864 tests, 858 pass, 0 fail, 6 todo   exit 0
npm run typecheck                                                  exit 0
npm run build                                                      exit 0
npm run test:business        1/1                                   exit 0
npm run test:dc-replacement  1/1                                   exit 0
git diff --check                                                   exit 0
gitleaks 202d045..HEAD       no leaks found
gitleaks --no-git            7 findings, all pre-existing public values, none in a changed file
```

## Desktop Commander

Zero calls. `.claude/settings.json` denies `mcp__plugin_desktop-commander_desktop-commander__*`,
and the server did not connect in this session at all. Every step above used WAG durable state, the
filesystem, Git, `node`, PowerShell process enumeration, or read-only CDP inspection.

## The leased commit

```text
run_authority     prop_3ec44bc2f4df80ad99712218  DELEGATED_RUN  git.commit
                  result_id res_b2895a652028ef75315647258449bc14

commit_authority  cmt_c394724d-747a-4888-8b75-beac350c09b4
                  authority   POLICY_APPROVED
                  lease_id    lease_mubsstqa_5e468457
                  branch      work
                  old_head    5d9dc357d9bca5a79280afd6a04fae583a16d519
                  path_count  1

commits           state SUCCEEDED
                  result_commit 1c1297e863aab46ae2bfd69e7419e4d499bf4311
                  paths   ["README.md"]
                  changes [{"status":"M","path":"README.md"}]
```

Git agrees, independently of the store:

```text
HEAD            1c1297e863aab46ae2bfd69e7419e4d499bf4311   = result_commit
branch          work                                       = the branch the lease bound
parents         1  ->  5d9dc357d9bca…                      = old_head, so the CAS held
files changed   README.md only, 1 file, 4 insertions
```

`git show HEAD:README.md` is byte-identical to the mutated file, so the commit carries exactly the
effect the delegated Run produced and nothing else.

### The defect this step found

The first `git.commit` proposal reached `DELEGATED_RUN` and then expired at `PENDING_APPROVAL`.
`DurableCommitCoordinator.admitByPolicy` performs the full lease evaluation and **nothing called
it** — both runtimes' lease interval drove mutations only. A configured lease therefore admitted
mutations autonomously and silently never admitted a commit, while the CLI reported autonomous
admission as enabled. Fixed by adding the counterpart driver and wiring both runtimes to it, with
four tests including a source assertion on the interval bodies, because the defect was never in the
decision — only in the absence of a caller.

## Replay protection, a second and stronger observation

The retry after that fix carried a block byte-identical to the first attempt, so it produced the
**same WAG-computed fingerprint**, which the first attempt had already claimed. Staging refused it
as `PROPOSAL_REPLAY`, spent nothing and wrote no row.

This is stronger evidence than the three-observation case above. Those three came from one assistant
message, so the extension's own suppression memory could plausibly have caught them. This one came
from a **different assistant turn with a different message id** — the extension had no reason to
suppress it and did not. Only WAG's durable fingerprint check stopped it.

The commit finally landed under a block whose only difference was the commit message, which changes
the fingerprint.

```text
delegation_claims   3 of 8      one mutation, one refused-then-superseded commit, one commit
delegated_run_refusals  PROPOSAL_REPLAY slot_claimed=0  x4
mutations SUCCEEDED     1
commits   SUCCEEDED     1
HUMAN_RUN rows          0
```

## Restart and recovery, after the commit

The gateway was stopped and restarted, then the page was reloaded and every assistant turn
re-observed. The snapshot — durable rows, Git state and file bytes — was **identical** before and
after, including `gitHead`, `committedPaths`, `claims`, `commitAuthorityRows` and the README hash.
Nothing re-ran, no commit was duplicated, and no slot was spent.

## Final acceptance matrix

| Link | Result | Primary evidence |
| --- | --- | --- |
| Browser DELEGATED_RUN (mutation.preview) | PASS | `prop_e8ab2e13…` `result_id res_53fad728…` |
| POLICY_APPROVED mutation under the lease | PASS | `mutation_authority` → `lease_mubsstqa_5e468457`, SUCCEEDED |
| Effect on disk | PASS | README.md 256 bytes, sha256 = recorded `result_sha256` |
| Verify | PASS | configured `unit` profile, 1/1, exit 0 |
| Browser DELEGATED_RUN (git.commit) | PASS | `prop_3ec44bc2…` `result_id res_b2895a65…` |
| Leased commit admission | PASS | `commit_authority` POLICY_APPROVED, `path_count 1`, `old_head 5d9dc357…` |
| Bounded local commit | PASS | HEAD `1c1297e8…` = `result_commit`, single parent, README.md only |
| Exactly one effect of each kind | PASS | 1 mutation SUCCEEDED, 1 commit SUCCEEDED, 3 of 8 slots |
| Restart / recovery | PASS | full snapshot identical across a gateway restart |
| Durable replay / idempotence | PASS | 4 × `PROPOSAL_REPLAY`, all `slot_claimed=0`; counts unchanged after re-observation |
| No human gesture on the proven path | PASS | `HUMAN_RUN` rows: 0; no operator approval involved |
| Zero Desktop Commander calls | PASS | denied in settings, server never connected, none made |

```text
WAG_DC_REPLACEMENT = PASS
WAG_PRIMARY        = YES
DC_FALLBACK_ONLY   = YES
```

### What this does not claim

- **Extension-side suppression idempotence.** One cache entry was deliberately released under
  explicit operator authorisation, so that property was not under test. WAG's durable replay
  protection, which is the guarantee, was never touched and is evidenced above.
- **Human authorship of the page text.** The prompts were composed here and submitted by a person;
  the model wrote the tool blocks. What is proven is the *Run transition* — WAG turned an untrusted
  page's text into a proposal with nobody clicking Run — not who typed the request.
- **A WAG verify job.** The verify step executed the configured profile's argv locally against the
  mutated tree. It is not a `verify.run` record.

### Residuals carried forward

- Four hand-written copies of `sameAuthority` remain outside `authority-tuple.ts`
  (`admitted-workspace.ts`, `browser-verify-request.ts`, `durable-verify-job.ts`, `durable-store.ts`).
- The shipped side panel still drives v4, so a human Run there opens a v4-owned workspace. The
  activation instrument now mints the v5 workspace, so this no longer blocks anything.
- Extension diagnostics remain unproven in production: a CDP recorder attached to one worker does
  not survive MV3 recycling, so records emitted by a recycled worker are not captured. This is a
  limitation of the recorder, not established as a WAG defect.
- A conversation's code blocks render into a virtualised viewer; a freshly completed turn can read
  as empty until it hydrates. A tab reload materialises it. Observed twice.
