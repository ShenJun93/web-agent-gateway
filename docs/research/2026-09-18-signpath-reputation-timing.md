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

It does support treating a 9-day-old executable project with no public release history as materially higher-risk than the sampled accepted projects.

## WAG timing recommendation

Do not manufacture activity and do not wait for an invented numeric threshold.

Recommended sequence:

1. complete the authorized public-readiness integration;
2. publish the repository with the real Apache-2.0 license and policies;
3. choose a non-placeholder product version;
4. publish the honest unsigned preview release required by the documented SignPath release condition;
5. accumulate **real** public evidence naturally:
   - subsequent source commits;
   - issue/discussion activity if users create it;
   - real preview downloads;
   - bug fixes or documentation improvements;
   - additional preview/release history only when warranted;
6. submit when the project can show a credible maintained public history, rather than immediately after flipping visibility solely to satisfy the form.

There is no defensible numeric waiting period from SignPath's published policy.

### Practical decision rule

Submitting immediately after publication is technically possible once the documented hard requirements are met, but has elevated discretionary rejection risk.

A stronger application point is reached when WAG can honestly show:
- public repository continuity rather than a same-day publication;
- at least one genuine downloadable Windows release in the intended form;
- visible maintenance after that release;
- an understandable README/security/privacy/signing posture;
- verifiable GitHub-hosted build provenance.

Do not delay a clearly useful real release just to age the repository. Conversely, do not submit on the same day as publication and describe nine days of private development as public reputation.

## Current state

```text
WAG_REPOSITORY_AGE_2026_09_18 = 9_DAYS
SIGNPATH_NUMERIC_REPUTATION_THRESHOLD = NONE_PUBLISHED
IMMEDIATE_POST_PUBLIC_APPLICATION = POSSIBLE_BUT_HIGHER_DISCRETIONARY_RISK
RECOMMENDED = BUILD_REAL_PUBLIC_RELEASE_AND_MAINTENANCE_EVIDENCE
FAKE_ACTIVITY_OR_POPULARITY = PROHIBITED_BY_PROJECT_POLICY
```

This recommendation is risk management, not a claim about SignPath's unpublished acceptance algorithm.
