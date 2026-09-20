# ADR-0027: Allow a Fixture-Only Harness Authority Lane Outside the Human-Presence Invariant

Date: 2026-09-20
Status: Accepted
Depends on: ADR-0019, ADR-0023, ADR-0026
Evidence: `docs/benchmarks/2026-09-20-harness-test-lane-decision.md`

## Context

ADR-0026 states the invariant without qualification:

```text
LOCAL_OPERATOR_APPROVAL = REQUIRED_FOR_EVERY_EFFECT
RUN_AND_APPROVAL = HUMAN
```

`docs/benchmarks/2026-09-20-wag-local-operator-primary-cutover.md` records the same thing as
`HUMAN_GESTURES_REQUIRED = RUN_IN_PANEL + APPROVE_IN_OPERATOR`, and
`.claude/rules/human-presence-boundary.md` tells every agent that reads it that "no proposal
becomes an effect without the operator's authenticated approval".

A live dogfood then showed what that costs during development: four defects in the operator path
took most of an afternoon to find, and each iteration of the fix-and-check loop needed two human
gestures from the operator. The measured workflow gap is not a missing capability — it is that
debugging a two-gesture path is only possible at the operator's pace.

`docs/benchmarks/2026-09-20-operator-origin-repair-decision.md` already accepted one exception, for
a browser probe, and bounded it explicitly: "the coordinator is a stub defined in the file;
approving it increments a counter and touches nothing else — **no durable store, no workspace, no
backend**."

The harness lane has all three. It is therefore not covered by that bound, and an independent
review was right that recording it only at the benchmark layer leaves the ADR-layer invariant
reading as absolute to anyone following AGENTS.md's required reading order.

## Decision

A **fixture-only harness authority lane** may perform the equivalents of both human gestures,
outside the ADR-0026 invariant, when every one of the following holds:

1. it acts only on a durable store it created itself, under a filename the harness module owns
   and which is not the production store's;
2. it is created, never opened — the root is made with a single atomic non-recursive `mkdir`, so
   no existing store can be adopted, marked, or raced into;
3. its root is outside the production state directory, outside the repository, and is not a UNC
   or device-namespace path;
4. its fixture is admitted through the same path policy the production surface uses;
5. it is off unless an explicit environment opt-in and an exact lane literal are both present;
6. no production module imports it, references it, or acquires a mode because of it;
7. it is excluded from the shipped build output;
8. **if it serves HTTP, it serves only the production review server, unmodified, over its own
   coordinator** — bound to an ephemeral loopback port, reachable only by a caller that already
   holds the lane's own bootstrap, confined per request to the lane's single workspace, and
   writing no `.operator-url` file by which anything could mistake it for production's.

Condition 8 was added on 2026-09-21. The original seven were written for a lane that was a
library; the lane now hosts a review server so the CSRF, Origin, TTL and single-use loops can be
iterated without a human, and "binds a listening socket with a live approve route" is a property
none of the first seven addressed. The point of routing it through the *unmodified* production
server is that a regression in those checks fails in the lane instead of costing a human gesture
to discover — a relaxed copy would defeat the purpose entirely.

The invariant is amended to read:

```text
LOCAL_OPERATOR_APPROVAL = REQUIRED_FOR_EVERY_EFFECT_ON_A_PRODUCTION_RECORD
RUN_AND_APPROVAL = HUMAN_ON_THE_PRODUCTION_PATH
HARNESS_LANE_AUTHORITY = FIXTURE_ONLY_AND_SEPARATELY_CONSTRUCTED
```

ADR-0026 is otherwise unchanged. No browser caller, no admitted session, and no operator route
gains anything from this decision.

## What this does not decide

- It does not make the lane a production capability. That needs its own ADR.
- It does not weaken the production path. The two human gestures remain required for any record in
  the production store, and the operator server is untouched by this decision.
- It does not claim containment against a same-user adversary. The lane is a file, and a file can
  be edited; ADR-0019 already places that adversary outside the containment claim. What is claimed
  is narrower: no *input* to the lane reaches a production record.

## A second consequence: opening the operator page

`npm run operator:open` (`src/operator-launch.ts`, `scripts/open-operator.ts`) exists so a runtime
restart does not require the operator to run PowerShell by hand. It reads WAG's single-use
bootstrap and serves one loopback redirect to it, so the token never reaches argv, a log, a file
or any tool output.

It deliberately does **not** open a browser. A review observed that automating that step lets an
authenticated operator session come into existence with nobody present, and that combined with
this branch's recorded residuals — a reference-based click is invisible to the hook, a shell is a
same-user escape hatch — the sequence "open the page, then approve by reference" would contain no
human gesture at all. Printing a link that a person must open keeps the ADR-0026 boundary intact.
Running the helper produces a link and nothing else.

## Consequence for the project rules

`.claude/rules/human-presence-boundary.md` states the invariant absolutely and needs a qualifier
pointing here. That file is covered by a deny rule in `.claude/settings.json` that the harness
itself installed, so it was not edited as part of this decision. Until it is, a reader of that rule
will hold a stronger belief than this ADR supports — recorded here rather than left implicit.

Two further statements in the always-loaded rules are now imprecise, for the same reason and with
the same blocker:

- `.claude/rules/human-presence-boundary.md` says the guard "refuses a shell command that … reads
  the credential file". It refuses a command whose *text* names that file next to a read verb.
  `npm run operator:open` reads it and is not refused, because the guard sees a tool name and an
  input, not a process tree.
- `.claude/skills/wag-live-dogfood/SKILL.md` says "Do not open the operator URL file." The helper
  reads it, by design, and is the sanctioned way to do so.

Neither makes the helper unsafe — it cannot approve, and it hands the token to nobody — but a
reader of those two files currently believes something narrower than what ships. The corrected
text is prepared and awaiting authorisation with the rest of the pending `.claude` patch.

## Decision markers

```text
ADR_0027 = ACCEPTED
HARNESS_LANE = FIXTURE_ONLY_TEST_AUTHORITY
HARNESS_LANE_MAY_SERVE = UNMODIFIED_REVIEW_SERVER_OVER_ITS_OWN_STORE
PRODUCTION_HUMAN_PRESENCE = UNCHANGED
NEW_BROWSER_OR_OPERATOR_AUTHORITY = NONE
OPERATOR_LAUNCH_HELPER = PRINTS_A_LINK_A_HUMAN_OPENS
RULE_QUALIFIER_OUTSTANDING = human-presence-boundary.md, wag-live-dogfood/SKILL.md
```
