## Summary

Describe the change and the user/developer outcome it enables.

## Authority and scope

- Does this widen capabilities, mutation, process/Git/browser authority, credential handling, native-host trust, or signing/release behavior?
- If yes, link the approved design/evidence that authorizes it.

## Verification

List the focused tests or checks run. For source changes, include the relevant typecheck/build/test results.

## Security and release impact

Describe any effect on security boundaries, privacy, build provenance, native-host artifacts, release identity, or signing. Write `None` when there is no effect.

## Checklist

- [ ] The change is scoped and reviewable.
- [ ] No secrets, credentials, private repository material, or user data are included.
- [ ] Existing fail-closed validation is not weakened to make a test/provider pass.
- [ ] Documentation/evidence is updated when behavior or authority changes.
- [ ] Security-sensitive details are handled according to `SECURITY.md`.
