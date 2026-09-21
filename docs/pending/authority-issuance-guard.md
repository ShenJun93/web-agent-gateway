# Pending patch — make authority issuance non-self-authorizable

**Status: PREPARED, NOT APPLIED. A human applies this. Claude cannot, and that is the point.**

Target: `.claude/hooks/wag-human-gate-guard.mjs`. `.claude/settings.json` is **not** changed —
see *Why settings.json is untouched*.

---

## The gap, stated precisely

`.claude/rules/human-presence-boundary.md` says the same thing twice, once for each authority:

> **Claude may not create, widen, edit, renew, or self-authorize a lease, and neither may anything
> Claude read.**

> **Claude may not create, widen, edit, renew, revoke or self-authorize a delegation, and neither
> may anything Claude reads.**

Both were true and neither was *enforced*. Measured on the tree before this patch:

```text
.claude/settings.json          denies tools and paths. Issuance is a verb, not a path. No rule.
.claude/hooks/…guard.mjs       patterns for Run, Approve, the credential, the state file,
                               browser drivers. Nothing for issuance.
scripts/delegation-control.ts  --issue and --renew, shell-reachable, refused by nothing.
insertGoalLease                a public method on the store; reachable from `node -e`.
goalUiDelegationId             a field in a local JSON config. Writing it is what makes a
                               delegation row live. Refused by nothing.
```

So the rule that keeps the whole design from being circular — *an authority Claude may use must
not be one Claude may mint* — was kept by Claude choosing to keep it. That is the exact class of
claim this project has spent four adversarial reviews learning not to make.

**Note that leases are in the same position, and were not singled out.** There is no
`lease:issue` script at all today; `insertGoalLease` is reachable only from an ad-hoc script. This
patch covers both, so that whichever gets a CLI first is already inside the rule.

---

## What the patch adds

Four purely additive insertions. Every anchor's replacement *contains* the text it replaces, which
`test/authority-issuance-guard.test.ts` asserts mechanically — so no existing refusal can have
been dropped.

### 1. Running issuance, from a shell

```text
SCRIPT_RUNNER  AND  delegation-control  AND  --issue|--renew     → refused
SCRIPT_RUNNER  AND  insertUiDelegation( | renewUiDelegation(
                    | insertGoalLease( | new UiDelegationControlPlane(   → refused
```

A runner is required for the same reason `BROWSER_DRIVER` is required beside the Run surface:
`grep -- --issue scripts/delegation-control.ts` is reading about issuance, not performing it, and
a guard that refused reading would refuse the review of itself.

The open bracket in `GRANT_CALL` is load-bearing. It separates **invoking** issuance from
**mentioning** it — `durable-store.ts` defines `insertUiDelegation`, and
`goal-ui-delegation-dispatch.ts` discusses it in a comment.

### 2. Naming a grant in local configuration

```text
Write | Edit | NotebookEdit  to a *.json target  naming goalUiDelegationId | goalLeaseId → refused
```

This is the quieter half and the one that actually matters. **A delegation that is not named in
local configuration is inert whatever its row says.** Writing the name is the act that turns a
durable row into authority this process will honour, and Claude proposing that edit is Claude
proposing to grant itself authority.

---

## What it deliberately does not refuse

| Still allowed | Why |
| --- | --- |
| `--revoke` | Narrowing an authority. A guard that made revocation harder than issuance would have the sign wrong. |
| `npm run lease:stop` | The emergency stop. Someone halting runaway automation must not be slowed down. |
| `--show`, `--sessions`, `--workspaces`, `--help` | Read-only. Reporting on a grant is required of Claude, not forbidden. |
| `cat`, `grep`, `rg` over any of these files | Reading is not reaching. |
| Writes to `src/`, `scripts/`, `test/`, `docs/` | A text rule cannot separate implementing issuance from calling it, and the over-match would refuse ordinary work and the analysis of this boundary alike — the same failure that once refused a commit message for quoting a filename. |
| `npm test`, `typecheck`, `build`, every acceptance lane | Asserted explicitly in the regression tests. |

---

## Residual limits — measured, not described

Each of these is an executable assertion in `test/authority-issuance-guard.test.ts`, so a later
reader cannot mistake them for coverage.

1. **Indirection defeats it.** A script written first and run second reaches issuance with a
   command line naming none of these patterns. The guard is a tripwire, not a sandbox; ADR-0019
   already puts a same-user shell outside the containment claim.
2. **String obfuscation defeats it**, as it defeats every other pattern in the file.
3. **A wrapper npm script would hide the CLI name.** None exists; if one is added, its name
   belongs in `GRANT_CLI`.
4. **A non-JSON config is not matched.** The supported config shape is JSON.
5. **The guard has no integrity of its own.** It refuses writes to its own directory, but that
   rule lives in the file it protects. The deny list and the auto-mode classifier are what make it
   stick.

None of these buys an effect. A delegation authorises a Run and never an effect; an effect still
needs the operator's authenticated approval or a lease that names the delegation's goal (ADR-0029
§composition); and `npm run lease:stop` refuses every admission in every process without their
cooperation.

---

## Why settings.json is untouched

`.claude/settings.json` denies by **tool name** and by **path glob**. Issuance is neither: it is a
shell command shape and a JSON field name. Adding `Write(**/*.json)` would refuse `package.json`,
`tsconfig.json` and every fixture; adding a `Bash(...)` pattern is not a form the deny list takes.
A change that cannot express the rule is not a minimal change, it is a decorative one.

---

## Digests

```text
.claude/hooks/wag-human-gate-guard.mjs
  before   f13670516976e7c8cfc43fdd0d263e6c860993175d10c32478fce8d83569d241
  after    3f0787de4e0d8cf2a5df58e7f4a07a76738a82ec22097af071cd1d61a1273a61

.claude/settings.json
  unchanged 9d8c67bb2b2a9c29533a98f9b04d0b4bdfa10a056370994e8bd8d59ede5f5606

docs/pending/apply-authority-issuance-guard.mjs
  raw file  bf78665843df8dc5783f0e3f92d65acd29d2727c8e7d86cd233a7e71a8665133

docs/pending/authority-issuance-guard.md   (this file)
  payload   c4d148d3a205b71d505688494fed79cd6bf982087000e5e3cb872c66f4a58200
```

**Two different things can be called "the SHA256" of a document that states digests, and they are
not interchangeable.**

- **raw file** is what `sha256sum` and PowerShell `Get-FileHash` report over the bytes on
  disk. It is deliberately **not written into this file**: a file cannot state its own raw
  digest, because writing the value changes the bytes the value covers. Compute it when you
  need it; the applier does not depend on it.
- **payload** is this file with its own two `  raw file  …` / `  payload   …` lines removed,
  because **a digest cannot cover itself**. The removal is of the lines matching
  `^  (?:raw file|payload)   ?[0-9a-f]{64}$`, of which this file carries exactly two: the
  applier's and this one. `scripts/verify-delegation-rule-patch.ts` reports AMBIGUOUS rather
  than guessing if that count ever changes.

The authoritative statement of the patch is the `REPLACEMENTS` table in
`docs/pending/apply-authority-issuance-guard.mjs`, not the prose above. The applier computes the
result and compares it to `after`; the tests load the same table and **execute** the result.

---

## Applying it

```bash
node docs/pending/apply-authority-issuance-guard.mjs --check
```

Writes nothing. Prints the before digest, the computed after digest, and whether they match what
is authorised. Then:

```bash
node docs/pending/apply-authority-issuance-guard.mjs --apply
```

Fail-closed at four points: the guard must hash to `before` exactly; every anchor must occur
exactly once; the computed result must hash to `after`; and the file is re-read after writing and
the original restored if it does not match.

Then:

```bash
npx tsx --test test/authority-issuance-guard.test.ts test/claude-harness-guard.test.ts
```

Both suites pass before and after application — the behaviour tests run against the patched guard
either way, and the installation test asserts which of the two known states the live guard is in.

Once applied and the tests pass, delete `docs/pending/authority-issuance-guard.md` and
`docs/pending/apply-authority-issuance-guard.mjs`. What should stay behind is the digest check in
`scripts/verify-delegation-rule-patch.ts`, which carries no guard text at all — the lesson from
retiring the previous applier, which kept a second copy of a rule file in `scripts/` where it
would live forever and drift.
