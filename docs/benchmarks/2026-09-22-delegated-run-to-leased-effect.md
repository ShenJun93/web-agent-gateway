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
npm test                     860 tests, 854 pass, 0 fail, 6 todo   exit 0
npm run typecheck                                                  exit 0
npm run build                                                      exit 0
npm run test:business        1/1                                   exit 0
npm run test:dc-replacement  1/1                                   exit 0
git diff --check                                                   exit 0
```

## Desktop Commander

Zero calls. `.claude/settings.json` denies `mcp__plugin_desktop-commander_desktop-commander__*`,
and the server did not connect in this session at all. Every step above used WAG durable state, the
filesystem, Git, `node`, PowerShell process enumeration, or read-only CDP inspection.

## What is not yet proven

The **leased `git.commit`** has not run. It requires a `git.commit` proposal originating from the v5
browser path, which requires one more assistant turn; submitting a prompt is refused to this agent
by the platform classifier, consistent with this project's own rule that keyboard and mouse
automation are not available to it. The block is prepared and verified against both grants.
