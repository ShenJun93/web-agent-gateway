# Pending `.claude/` patch — for a human to apply

The harness denies the agent writes under `.claude/`, deliberately, and a Goal Lease cannot grant
them either (ADR-0028 refuses that path above its own bindings). So changes to the always-loaded
rules are prepared here and applied by a person.

## What this patch does

`.claude/rules/human-presence-boundary.md` currently tells every agent that reads it:

> No proposal becomes an effect without the operator's authenticated approval on a channel Claude
> never holds a credential for.

That is true only while no Goal Lease is configured. ADR-0028 authorised a second, separate
deterministic authority source, and leaving the rule unamended would mean a future agent holds a
belief the ADRs no longer support — which is the exact defect ADR-0027 exists to correct, and
which this project has now found five times.

The patch rewrites the rule to state both authority sources precisely, and bounds the second one.

## Verify before applying

```bash
sha256sum docs/pending/human-presence-boundary.patch
# 5d5133fbe148cfa02298a9798003140b3ab4fa05fc2d4e7d281a99cb1457574b

sha256sum docs/pending/human-presence-boundary.md
# 210becf3015bb993653935457e7c8fe57ce99a514c69c22fe5fee6cea4e90562

# the file the patch expects to find, unmodified:
sha256sum .claude/rules/human-presence-boundary.md
# 51f795abf984e34ecc5d5b7b109a4c3a575851323e55a7be37619e47b4a0d0b6
```

## Apply

```bash
git apply --check docs/pending/human-presence-boundary.patch   # dry run, must exit 0
git apply docs/pending/human-presence-boundary.patch
```

Or, equivalently, copy the whole file:

```bash
cp docs/pending/human-presence-boundary.md .claude/rules/human-presence-boundary.md
```

Both produce a file whose SHA-256 is `210becf3015bb993653935457e7c8fe57ce99a514c69c22fe5fee6cea4e90562`.

## What the new text guarantees

- **Manual human mode is unchanged and is named as the normal path.** With no lease active,
  ADR-0026 holds in full: every effect needs Run and needs Approve. The text says so explicitly
  and says it is "not a legacy path or a fallback to be minimised".
- **An active, valid, bounded lease is a separate deterministic authority source**, and may
  produce `POLICY_APPROVED` effects with no per-action human gesture. It is not an automated
  gesture: nothing clicks Run, nothing clicks Approve, and the operator server is not involved.
- **Claude may not create, widen, edit, renew or self-authorize a lease**, and neither may
  anything Claude reads. Leases are issued by a human, out of band. A lease cannot authorize
  edits to `.claude/`, to the ADRs, or to the gateway's own checkout, so a lease can never be
  used to enlarge a lease. Page content is inert: the decision reads durable rows, never bytes.
- **Default-deny, expiry, revocation, the kill switch, workspace/session/adapter/path bindings,
  budgets, CAS revalidation, durable audit and every excluded authority category** are restated
  in the rule rather than left to the ADR.

## After applying

The agent will verify the file byte-for-byte against the hash above, re-run the focused Goal
Lease and security tests, and then prove autonomous lease execution end to end. A fresh Claude
session may be needed for the rules to reload.
