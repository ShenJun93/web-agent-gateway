# Human-presence boundary

WAG has two human gestures. Neither may be automated, simulated, or worked around.

1. **Run**, in the WAG side panel. Turns an untrusted page's text into a WAG proposal.
2. **Approve / reject**, on the local operator review server. The only thing that causes an effect.

ADR-0026 states it directly: `ATTACHMENT_AND_RESCAN = AUTOMATED`, `RUN_AND_APPROVAL = HUMAN`.
Also never automated: passwords, passkeys, MFA, auth consent, identity verification, payments,
signing, provider enrollment, and OS or browser security bypasses.

## What Claude may automate freely

Opening and focusing windows, navigation, opening the side panel, extension and runtime
inspection, ordinary reload/reattach/rescan/reconnect, DOM/console/network inspection, selecting
ordinary page controls, entering non-secret fixture data, reproducing defects, reading results,
and test-environment cleanup. Reattachment and rescan are the extension's own job and are
idempotent by proposal identity — do not treat needing them as a reason to ask for a human.

## At a gate

Finish every automatable prerequisite first. Make the proposal visible and verify it is the exact
one expected. Then ask for **one** gesture, stop, and — once it is done — detect the resulting
state transition yourself and carry on without asking for direction again.

Detect the transition from WAG's durable state, not by driving the panel.

## How this is enforced, precisely

- `.claude/hooks/wag-human-gate-guard.mjs` (PreToolUse) refuses the actuating Computer Use verbs
  outright, and refuses any browser or shell call that names a WAG authority surface.
- `.claude/settings.json` denies the same Computer Use verbs as defense in depth.
- The computer-use server grants browsers at tier `read`, so its clicks into Edge are refused
  before this project's rules are even consulted.
- **WAG itself is the actual boundary.** No proposal becomes an effect without the operator's
  authenticated approval, and Claude is never given the operator origin, its single-use
  bootstrap, its cookie, or its CSRF token.

What is *not* claimed: a shell is a same-user escape hatch, and the guard's shell coverage is a
tripwire, not a sandbox. ADR-0019 already places a compromised same-user account outside the
containment claim. Do not describe this enforcement as stronger than that.
