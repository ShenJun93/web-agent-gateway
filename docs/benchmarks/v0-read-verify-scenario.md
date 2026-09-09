# V0 Read/Verify Benchmark Scenario

Date: 2026-09-09
Fixture HEAD: `57bcd8421936f3e44dba4eda80bbb98f583f8432`
Decision: ADR-0005

## Gateway measured actions
1. `workspace.open` once for a cold run; warm runs reuse the opaque workspace ID.
2. `repo.snapshot`.
3. `file.read` for `src-math.js`.
4. `file.read` for `src-greet.js`.
5. `file.read` for `src-clamp.js`.
6. `file.read` for `src-version.js`.
7. `file.read` for `src-even.js`.
8. `verify.run` using the fixed test profile.
9. final `repo.snapshot`.

No patch, raw shell, Git mutation, or hidden mutation through `verify.run` is permitted in this V0 scenario.

## DC comparison subset
Derived without remeasurement from `dc-baseline.json`:
- initial snapshot
- five file reads
- first `npm test`
- final status

Raw derived evidence is `dc-read-verify-subset.json`.

DC subset totals across the five recorded runs: 21.774s, 24.786s, 18.020s, 11.708s, 12.318s. Median: 18.020s. Sample p95: 24.184s.

Report Gateway cold and warm timing separately. Do not claim full coding-task equivalence from this read/verify benchmark; mutation remains a post-GO experiment.
