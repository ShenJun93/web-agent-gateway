# Pending human patch — add `sessionCorrelation` to the authority-write refusal

2026-09-22. A prepared patch a human applies out of band, in the same way
`docs/pending/human-presence-boundary-goal-ui-delegation.md` was applied. Claude prepared and
verified it but must not apply it: the target is under `.claude/`, which Claude is denied.

## Why

`sessionCorrelation` (ADR-0030, `src/private-config.ts`) selects which durable session the private
stdio surface acts as, and therefore which session a Goal Lease's `admittedSessions` is matched
against. Writing it into a gateway config is authority configuration in exactly the sense that
naming a `goalLeaseId` or `goalUiDelegationId` is: an agent that could write it could bind the
surface to a session an existing lease already admits, and so cause an effect with no human
approval. The PreToolUse guard already refuses an agent writing the other two into a JSON config;
it does not yet know about this one. This closes that gap.

It is defence in depth, not the boundary itself — `human-presence-boundary.md` is explicit that the
guard is a tripwire and a shell is a same-user escape hatch. The load-bearing protection is that the
correlation is read from local configuration only and issuance is human-only. This makes the guard's
refusal list agree with that rule.

## Exact change

- File: `.claude/hooks/wag-human-gate-guard.mjs`
- Patch: `docs/pending/add-sessionCorrelation-to-guard.patch` (two hunks)
- Behaviour change: `GRANT_CONFIG_FIELD` gains `sessionCorrelation`; the refusal message names the
  third field. No deny/allow verdict changes for any existing input — every `goalLeaseId` /
  `goalUiDelegationId` case is refused byte-identically as before. The change only *adds* refusals
  for `sessionCorrelation` and makes the message accurate.

```text
SHA256 before  3f0787de4e0d8cf2a5df58e7f4a07a76738a82ec22097af071cd1d61a1273a61   (18880 bytes, LF)
SHA256 after   d3218fd6d5f33fb8a68f57e48aca86261a9d9236b85eae26741fedebbe87bba9   (19124 bytes, LF)
```

`before` equals the value `scripts/verify-delegation-rule-patch.ts` currently pins as
`ISSUANCE_GUARD_SHA256`, so the guard is in its known committed state and nothing has drifted.

## Apply (one command, from the worktree root)

```bash
git apply docs/pending/add-sessionCorrelation-to-guard.patch
```

`.gitattributes` (`* text=auto eol=lf`) keeps the guard LF, so the result is byte-exact.
`git apply --check docs/pending/add-sessionCorrelation-to-guard.patch` was run read-only beforehand
and reported a clean apply.

## Verify (read-only)

```bash
sha256sum .claude/hooks/wag-human-gate-guard.mjs
```

Expected: `d3218fd6d5f33fb8a68f57e48aca86261a9d9236b85eae26741fedebbe87bba9`. On PowerShell:
`Get-FileHash .claude/hooks/wag-human-gate-guard.mjs -Algorithm SHA256`.

## After you apply, Claude finishes autonomously (these are coupled, in files Claude may edit)

1. `scripts/verify-delegation-rule-patch.ts` — set `ISSUANCE_GUARD_SHA256` to the after-SHA, and
   move the prior authorised value to the before-anchor, so the drift check tracks the new state.
2. `test/authority-issuance-guard.test.ts` — the live-guard SHA assertion (line ~86) follows the
   pin; update the refusal-message assertion (line ~138) and the config-field mutation `from:`
   string (line ~302) to the patched text; add the focused tests below.
3. Run the guard test, the full suite, typecheck, build, the two acceptances, `git diff --check`
   and gitleaks; then update the readiness receipt's "flagged for the operator" note to "applied".

Until the human applies the patch, none of these are committed, because they assert against the
live guard and would be red while it is unpatched.

## Focused guard tests (added in step 2)

```ts
test('naming a session correlation in a JSON config is refused', () => {
  const reason = denied(
    call('Write', {
      file_path: 'E:/config/wag-private.json',
      content: JSON.stringify({
        repositoryEngineering: {
          mutation: { sessionCorrelation: 'session_11111111-2222-3333-4444-555555555555' },
        },
      }),
    }),
    'naming a session correlation in config',
  );
  assert.match(reason, /session correlation/);

  denied(
    call('Edit', {
      file_path: 'C:\\Users\\x\\wag.json',
      old_string: '{}',
      new_string: '{ "sessionCorrelation": "session_11111111-2222-3333-4444-555555555555" }',
    }),
    'naming a session correlation with Windows separators',
  );
});

test('the sessionCorrelation refusal does not spill onto reads or non-grant config', () => {
  allowed(bash('rg sessionCorrelation E:/config'), 'grepping for the field is reading, not naming');
  allowed(
    call('Write', { file_path: 'E:/config/wag-private.json', content: '{"allowedRoots":["E:/x"]}' }),
    'a JSON config write that names no grant is unaffected',
  );
  allowed(
    call('Write', { file_path: 'E:/notes.txt', content: 'sessionCorrelation is set by a person' }),
    'a prose mention in a non-config file is not a grant-naming write',
  );
});
```

## This document's own digest

```text
sha256(patch file add-sessionCorrelation-to-guard.patch)  covered by the after-SHA verification above
```
