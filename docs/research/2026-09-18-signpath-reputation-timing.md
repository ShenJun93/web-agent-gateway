# SignPath Foundation Reputation Timing Research — 2026-09-18

Status: research only. This document does not define an eligibility threshold and does not authorize delaying, submitting, or contacting SignPath.

## Why this matters

SignPath Foundation explicitly states that executable applications require a certain **verifiable reputation**, but it publishes no numeric minimum for project age, stars, users, downloads, releases, or contributors.

WAG's repository was created on 2026-09-09. On 2026-09-18 it is only 9 days old.

The purpose of this sample is to calibrate risk, not reverse-engineer a hidden rule.

Official policy:
- https://signpath.org/terms.html

SignPath Foundation website source:
- https://github.com/SignPath/fdn-website
- project entries are tracked in `docs/_data/projects.yml`

## Comparable sample

The Foundation website Git history provides an observable date when each project entry was first added to the public project list. This is a useful **upper-bound proxy for acceptance/listing timing**, but it is not necessarily the exact internal approval date.

| Project | Domain similarity | GitHub repo created | First observed Foundation-list commit | Approx. repo age at listing | Current stars observed 2026-09-18 |
| --- | --- | --- | --- | ---: | ---: |
| OpenPets | desktop app + optional MCP agent integration | 2026-05-04 | 2026-06-29 | ~56 days | ~1,208 |
| DeepSeek-Reasonix | AI coding agent / desktop + terminal | 2026-04-21 | 2026-06-29 | ~69 days | ~35,592 |
| PromptX | AI agent platform | 2025-05-13 | 2025-09-22 | ~132 days | ~3,691 |
| AMIGOpy | executable desktop/research app; low popularity | 2025-06-24 | 2025-12-02 | ~161 days | 8 |
| MCPProxy | MCP/AI-agent proxy | 2025-06-18 | 2026-02-06 | ~233 days | ~375 |
| OpenAgents Launcher | local AI-agent manager | 2025-03-10 | 2026-06-29 | ~476 days | ~4,109 |

Foundation-list commits observed in `SignPath/fdn-website`:
- MCPProxy: `9d454bd14396bf0d82cbf036bed18fa3bbe8d2c5`, 2026-02-06
- OpenAgents Launcher: `895160e6bd8e6616309bb62c6210e244033e8fda`, 2026-06-29
- PromptX: first observed add sequence beginning `6fdd35bac71b96a6292c64fc10f6bc2baea95c6a`, 2025-09-22
- DeepSeek-Reasonix: `895160e6bd8e6616309bb62c6210e244033e8fda`, 2026-06-29
- AMIGOpy: `c793a75cc53ee6f4687cc61e99af6939d2b2418e`, 2025-12-02
- OpenPets: `895160e6bd8e6616309bb62c6210e244033e8fda`, 2026-06-29

## Interpretation

No sampled project demonstrates that SignPath requires a fixed age.

The sample instead supports two different reputation patterns:

1. **Shorter public history with strong visible traction**
   - OpenPets and DeepSeek-Reasonix were listed after roughly two months of repository history, but both currently have substantial public adoption.
   - Current star counts are not historical star counts at acceptance, so they cannot be used as exact acceptance evidence.

2. **Longer history with modest popularity**
   - AMIGOpy is the strongest counterexample to a popularity threshold: it currently has only single-digit stars but had roughly five months of repository history before being added to the Foundation list.

The sample therefore does **not** support:
- a minimum star count;
- a minimum two-month rule;
- a minimum five-month rule;
- a required contributor count.

It does support treating a newly public executable project with no independent public trust signal as materially higher-risk than the sampled accepted projects.

## 2026-09-19 decision refresh

The earlier publication prerequisites are now complete:
- WAG is public under Apache-2.0;
- the public README/security/privacy/code-signing/install surface is available;
- `v0.1.0-preview.1` is an immutable unsigned Windows prerelease;
- GitHub release and asset attestations verify the frozen release identity;
- GitHub source-repository MFA is `PASS_VERIFIED_UI`;
- GitHub-hosted build provenance and the pre-sign candidate path are established.

Current live public-signal snapshot:
- stars: `0`;
- forks: `0`;
- subscribers/watchers: `0`;
- contributor list: `ShenJun93` only;
- release download counter: `4`, contaminated by maintainer verification downloads and therefore not usable as adoption evidence.

Accepted-project comparison still does not reveal a numeric threshold. AMIGOpy remains a useful low-star counterexample, but it had substantially longer public history and an independent research identity/footprint before its Foundation listing. This supports treating reputation as multidimensional rather than equating it with stars.

Discoverability is a separate supporting risk:
- GitHub-native repository search finds `ShenJun93/web-agent-gateway`;
- general public-web exact-name search is still weak/ambiguous against similarly named projects;
- the live form guidance says a Google search for the project name should clearly identify the project.

## WAG timing recommendation

Do not manufacture activity and do not wait for an invented numeric threshold.

The repository/release prerequisites are already complete. The next decision hinge is evidence, not elapsed time.

Decision state:
- `WAIT_REPUTATION_SIGNAL`

Resume application-readiness review when at least one genuine independent signal appears or exact-project public-web discoverability materially improves. Examples:
- an independent user/reference;
- a non-maintainer issue or contribution;
- independent community/blog/media discussion;
- uncontaminated usage/download evidence;
- materially clearer exact-name public-web indexing.

A truthful `Reputation` form answer can already disclose that WAG is newly public and provide verifiable repository/release/security/build evidence without claiming broad adoption. That makes the field answerable, but does not convert project-controlled evidence into independent reputation.

There is no defensible numeric waiting period from SignPath's published policy.

### Practical decision rule

Submission is technically possible once human form inputs and explicit submission authority exist, but current reputation/discoverability evidence creates elevated discretionary rejection risk.

A stronger application point is reached when WAG can add at least one genuine independent public signal to the technical evidence already complete. Do not delay a useful real release merely to age the repository, and do not create synthetic activity to trigger the decision rule.

## Current state

```text
SIGNPATH_NUMERIC_REPUTATION_THRESHOLD = NONE_PUBLISHED
TECHNICAL_REPOSITORY_PREREQUISITES = PASS
PUBLIC_UNSIGNED_RELEASE = PASS
REPUTATION_FORM_ANSWER = READY_AS_TRUTHFUL_DISCLOSURE
INDEPENDENT_REPUTATION_SIGNAL = NOT_YET_VERIFIED
PUBLIC_WEB_DISCOVERABILITY = WEAK
SUBMISSION_DECISION = WAIT_REPUTATION_SIGNAL
FAKE_ACTIVITY_OR_POPULARITY = PROHIBITED_BY_PROJECT_POLICY
```

This recommendation is risk management, not a claim about SignPath's unpublished acceptance algorithm.
