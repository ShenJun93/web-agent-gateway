# Deterministic Local-Coding Benchmark Scenario

Date: 2026-09-09
Fixture HEAD: `57bcd8421936f3e44dba4eda80bbb98f583f8432`
Fixture location during measurement: disposable temp Git repository on the Windows test machine.

## Reset

Before every measured run:

```text
git reset --hard 57bcd8421936f3e44dba4eda80bbb98f583f8432
git clean -fd
```

Reset time is not included in scenario total.

## Measured actions

Each action is a separate Remote Desktop Commander round-trip:

1. repository snapshot: status + branch + HEAD + diff summary
2. read `src-math.js`
3. read `src-greet.js`
4. read `src-clamp.js`
5. read `src-version.js`
6. read `src-even.js`
7. search for symbol `subtract`
8. patch `src-greet.js` from template-literal greeting to equivalent string concatenation
9. run `npm test`
10. inspect `git diff -- src-greet.js`
11. run `npm test` again
12. inspect final `git status --short`

The semantic patch preserves behavior, so both tests must pass and final Git status must show exactly one modified source file.

## Failure accounting

Run 1 contained one benchmark-command syntax error during the patch step. The failed call and its retry are retained in the raw evidence rather than removed. Runs 2-5 used the corrected deterministic patch command.

No failed transport calls, silent drops, reconnects, or re-auth events were observed during the five measured scenario runs.

## Comparison rule

A future Gateway -> DevSpace run must use the same fixture commit, semantic task, and failure-accounting rule. It may reduce remote tool-call count through semantic aggregation; that reduction is an intended architectural benefit and must be reported explicitly rather than normalized away.