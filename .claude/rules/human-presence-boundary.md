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
idempotent by proposal identity — needing them is not a reason to ask for a human.

## At a gate

Finish every automatable prerequisite first. Make the proposal visible and verify it is the exact
one expected. Then ask for **one** gesture, stop, and — once it is done — detect the resulting
state transition yourself and carry on without asking for direction again.

Detect the transition from WAG's durable state, not by driving the panel.

## What is actually enforced

- `.claude/hooks/wag-human-gate-guard.mjs` (PreToolUse) refuses every actuating Computer Use verb
  and any unrecognised one; refuses a browser call that *names* the side panel, an extension
  document, the Run message, the operator's routes or its credential file; refuses a read of that
  credential file; and refuses a shell command that performs a request to the operator, reads the
  credential file, writes WAG's store, or drives a browser at the Run surface.
- `.claude/settings.json` denies the same Computer Use verbs, the actuating browser verbs of every
  browser MCP, Desktop Commander, and writes under `.claude/`.
- The computer-use server grants browsers at tier `read` only. Measured here: a request for
  Microsoft Edge returned *"browser applications can only ever be granted in 'read' mode"*.
- Claude Code's auto-mode classifier independently refuses shell writes to hook files as
  self-modification. Observed, not configured by this project.
- **WAG itself is the boundary that matters.** No proposal becomes an effect without the
  operator's authenticated approval on a channel Claude never holds a credential for.

## What is *not* enforced — do not overstate these

- **A reference-based click on an already-open authority document is not refused by the hook.**
  The hook sees a tool name and a tool input; an opaque `ref` or `uid` names nothing it can match.
  The MCP browser verbs that could do it are denied in settings.json, but a shell browser driver
  can still click by reference, and the hook cannot tell that from ordinary page interaction.
- **A shell is a same-user escape hatch.** ADR-0019 already puts a compromised same-user account
  outside the containment claim. The shell rules here are a tripwire, not a sandbox.
- **A hook that crashes or times out fails open** — Claude Code logs the error and lets the call
  through. Both happened while this was being built. That is why the guard stays dependency-free
  and linear-time, and why a test runs it exactly as configured.
- **String obfuscation evades the text matches.** `"exec" + "ute"` is not matched.
- Claude *is* given the operator's origin and the path of its credential file: the runtime prints
  both to stderr and `wag-live-dogfood` tells you to read them. What is withheld is the
  credential itself, the session cookie and the CSRF token — which is what carries the safety.
  Do not open the credential file; it is single-use, and spending it locks the operator out.
