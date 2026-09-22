# The human-presence boundary patch was applied — by a human, out of band

2026-09-21. Branch `feat/goal-ui-delegation-v1`.

This records an **authority change that Claude did not make**. It is the hinge of ADR-0029, so the
provenance matters more than the content: the design's central claim is that Claude cannot grant
itself Run authority, and the only evidence for that claim is that Claude could not perform this
edit.

## What happened, in order

1. Claude proposed the change as a document, `docs/pending/human-presence-boundary-goal-ui-delegation.md`,
   and presented it at an authorization gate.
2. The user authorized it, naming the file, the digest, the exact two files, and `RUN_ONLY_NEVER_APPROVE`.
3. Claude attempted the edit through the sanctioned tool and was **refused**:

   ```text
   Edit .claude/rules/human-presence-boundary.md
   → Error: File is in a directory that is denied by your permission settings.
   ```

   Claude did not escalate to a shell. That refusal is not an obstacle the design works around; it
   *is* the design. `.claude/settings.json` denies Claude's writes under `.claude/`, and the file in
   question governs whether Claude's own automation may cause a Run.
4. Claude wrote `scripts/apply-delegation-rule-patch.ts` so the human's action could be exact rather
   than manual, and verified it with `--check`, which writes nothing.
5. **A human applied the patch out of band.** Claude then verified the result, below.

Authorization makes a change legitimate. It does not make Claude the right party to perform it.

## Verification, performed after the fact

### The resulting files are the expected ones

```text
.claude/rules/human-presence-boundary.md   7355153a8a89684e89c4dda6f42f7c0ed3451965ef7d6bbd3fa03838e4a4b2a9
.claude/rules/wag-primary-operator.md      70d08a13764b8473f00f30d2dd80ec17353f68bbd389d35242c3f9033dba797c
```

Both match the digests predicted at the gate. `git status --porcelain` shows these two files
modified and nothing else under `.claude/`.

### The change is the authorised patch and nothing else

Digests matching is weaker evidence than it looks — it proves the bytes are the ones predicted, not
that they are the ones the patch produces. So the transformation was reproduced independently, in
memory, from the committed baseline:

```text
loaded 5 replacements from the applier's own source
replacement 1..5   each anchors exactly 1x

.claude/rules/human-presence-boundary.md
  HEAD                 210becf3015bb993653935457e7c8fe57ce99a514c69c22fe5fee6cea4e90562
  reproduced from HEAD 7355153a8a89684e89c4dda6f42f7c0ed3451965ef7d6bbd3fa03838e4a4b2a9
  on disk now          7355153a8a89684e89c4dda6f42f7c0ed3451965ef7d6bbd3fa03838e4a4b2a9
  byte-identical       true

.claude/rules/wag-primary-operator.md
  HEAD                 8e16910d5808694235de50e83b87eaec7e1bca3ce777f09c0aadeb3e9ae863d9
  reproduced from HEAD 70d08a13764b8473f00f30d2dd80ec17353f68bbd389d35242c3f9033dba797c
  on disk now          70d08a13764b8473f00f30d2dd80ec17353f68bbd389d35242c3f9033dba797c
  byte-identical       true

VERDICT: the working tree is exactly HEAD + the authorised patch, and nothing else.
```

The replacement table was loaded from the applier itself — with only `export` added and the `main()`
call removed — so the check could not drift from what a human would run.

### The applier has since been retired

`scripts/apply-delegation-rule-patch.ts` was deleted once the patch was applied and committed. It
had to embed the rule file's invariant block verbatim in order to rewrite it, which left a second
copy of `.claude/rules/` text living in `scripts/` — and the fixture-lane isolation suite refused
that, because the block names the lane's own invariant and the suite asserts by substring that
nothing shipped mentions the lane.

The suite was right beyond that technicality: a second copy of a rule file is a second thing to
drift, and these files are the one artifact here whose exact bytes *are* the security property.

`scripts/verify-delegation-rule-patch.ts` replaces it and carries no rule text — only the digests
below. That turns a historical tool into a live invariant: it answers "are these files still the
ones a human authorised", which stays worth asking long after "apply the patch" stops being. It
reports rather than gating, because a human may legitimately edit these files and a gate that failed
the suite on every such edit is a gate people learn to edit.

## The two digests over the patch document, and why they differ

A review flagged a discrepancy: PowerShell reported one value, the applier another. Both are correct
and they cover different things. Neither should be called "the file's SHA256" without qualification,
and `scripts/verify-delegation-rule-patch.ts` now checks both, each named.

| Digest | Covers | Value |
| --- | --- | --- |
| **Raw file** | the 11,618 bytes on disk, as `sha256sum` / `Get-FileHash` report them | `35b3ff68…f25caac` |
| **Patch payload** | the file with its single `sha256(...)` line removed, including its newline | `bedf1543…e2fd67de` |

The payload digest is the authorised one. The reason is not
subtle: the document states its own digest, and **a digest cannot cover itself** — writing the value
into the file changes the file. Removing exactly the line that carries it is what makes a
self-describing artifact possible at all. The patch document has always said so in as many words;
what was ambiguous was the label on the number, in the gate presentation and in the applier's
output. The successor names which digest it means, for both.

### The transformation is unambiguous — measured, not assumed

The removal is `/^sha256\([^\n]*\n/m`, which without the `g` flag replaces the *first* match. If two
lines matched, the payload would depend on ordering. Measured against the file as it stands:

```text
byte length            11618
utf8 round-trips       true      (so decoded-text and raw-byte digests coincide here)
has BOM                false
contains CR            false
matches in file        1         (unambiguous)
  at line 236          "sha256(this file, digest line removed) = bedf1543…\n"
bytes removed          106
```

`utf8 round-trips = true` matters: it is why the raw-byte digest and a digest over the decoded
string agree for this file. They would not agree for a file with a BOM or invalid UTF-8, so the
raw-byte line is hashed from the bytes rather than inferred from the decoded string.

The check also reports **AMBIGUOUS** rather than guessing if the count is ever not exactly one.

## What the patch actually changed

`RUN` and `APPROVAL` were one invariant; they are now two.

```diff
-RUN_AND_APPROVAL        = HUMAN_UNLESS_A_VALID_LEASE_ADMITS_THE_ACTION
+APPROVAL                = HUMAN_UNLESS_A_VALID_LEASE_ADMITS_THE_ACTION
+RUN                     = HUMAN_UNLESS_A_VALID_UI_DELEGATION_ADMITS_THE_PROPOSAL
+UI_DELEGATION_SCOPE     = RUN_ONLY_NEVER_APPROVE
+UI_DELEGATION_ISSUANCE  = HUMAN_ONLY_AND_OUT_OF_BAND
-NO_LEASE_CONFIGURED     = ADR_0026_UNCHANGED_IN_FULL
+NOTHING_CONFIGURED      = ADR_0026_UNCHANGED_IN_FULL
```

**Approval semantics are unchanged.** A delegation admits a proposal; it causes no effect. The
effect still needs the operator's authenticated approval, or a Goal Lease that admits it. The two
authorities are independent and neither implies the other — which is what `RUN_ONLY_NEVER_APPROVE`
says, and what the policy enforces.

`UI_DELEGATION_ISSUANCE = HUMAN_ONLY_AND_OUT_OF_BAND` is the clause that keeps this from being
circular. Without it, an authority Claude may use would be an authority Claude may mint.

## What is still inert, and why that is not a caveat

Applying the patch changed what is *permitted*. It changed nothing observable, because the wiring
does not exist yet. Measured on this tree:

```text
nothing in src/ constructs the dispatch plane or the router — only the fixture lane does
goalUiDelegationId is parsed in src/private-config.ts and read by no module
the native host speaks v4 only; there is no v5 frame route
the shipped extension does not load delegated-dispatch-core-v5.js
abandonExpiredClaims has no caller in src/
v5 routes no human-Run verb, so it is delegated-only
```

This mirrors the Goal Lease exactly, and the mirror is worth stating: `insertGoalLease` has no
production caller either — only `src/harness-authority.ts` and tests. "Issued by a human, out of
band" is currently realised as *there is no path at all*. A live delegated Run therefore needs two
human acts that no amount of wiring removes: issuing the row, and naming it in local configuration.

## Residual limits

- This receipt attests to provenance by argument and by mechanism, not by cryptographic proof of
  authorship. What is verifiable is that Claude's write was refused, that Claude did not escalate,
  and that the bytes on disk are exactly the authorised transformation of the committed baseline.
- A shell remains a same-user escape hatch (ADR-0019). Whoever can write these files is already
  outside the containment claim. The deny list is a boundary for Claude's sanctioned tools, not a
  sandbox.
- The patch document must not be edited. Editing it changes both of its digests, which
  `scripts/verify-delegation-rule-patch.ts` reports as drift — the intended behaviour, and the reason
  the corrected labelling went into the tooling and this receipt rather than into the document.
