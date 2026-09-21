/**
 * Has the human-presence boundary drifted since it was authorised? (ADR-0029)
 *
 *   npx tsx scripts/verify-delegation-rule-patch.ts
 *
 * ## What replaced what, and why
 *
 * This supersedes `scripts/apply-delegation-rule-patch.ts`, which existed to make a human's one-time
 * edit exact. It did that on 2026-09-21 and the result is committed, so the applier's remaining
 * effect was to keep a **verbatim second copy of `.claude/rules/` text inside `scripts/`**.
 *
 * The fixture-lane isolation suite refused it, and was right twice over. The copied block names the
 * fixture lane's own invariant, and that suite asserts — by substring, deliberately, so it cannot be
 * evaded by spelling — that nothing shipped mentions the lane at all. Beyond that, a second copy of
 * a rule file is a second thing to drift, and the rule file is the one artifact in this repository
 * whose exact bytes are the security property.
 *
 * The same suite refused an earlier draft of *this* file, for quoting that suite's name in a
 * comment. Both refusals are the check working: it does not care why the text is there.
 *
 * So this carries **no rule text at all** — only digests. That makes it a live invariant rather than
 * a historical tool: it answers "are these files still the ones a human authorised", which stays
 * worth asking long after "apply the patch" stops being.
 *
 * ## Why it is a script and not a test
 *
 * A human may legitimately edit these files, and a gate that failed the suite on every such edit
 * would be a gate people learn to edit. This reports; it does not enforce. It is for a reviewer
 * asking whether the boundary is what the receipt says it is.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The digests recorded when the patch was applied, in
 * `docs/benchmarks/2026-09-21-goal-ui-delegation-boundary-patch-applied.md`.
 *
 * Reproduced there independently from the committed baseline, so these are not merely "what was on
 * disk afterwards" — they are what the authorised transformation produces.
 */
const AUTHORISED = [
  {
    path: '.claude/rules/human-presence-boundary.md',
    before: '210becf3015bb993653935457e7c8fe57ce99a514c69c22fe5fee6cea4e90562',
    after: '7355153a8a89684e89c4dda6f42f7c0ed3451965ef7d6bbd3fa03838e4a4b2a9',
  },
  {
    path: '.claude/rules/wag-primary-operator.md',
    before: '8e16910d5808694235de50e83b87eaec7e1bca3ce777f09c0aadeb3e9ae863d9',
    after: '70d08a13764b8473f00f30d2dd80ec17353f68bbd389d35242c3f9033dba797c',
  },
] as const;

/** The patch document's two digests. See the receipt for why a file cannot cover its own. */
const PATCH = 'docs/pending/human-presence-boundary-goal-ui-delegation.md';
const PATCH_RAW_SHA256 = '35b3ff68b929ae35ca6e8f3f27d1e8e4f88830029d4ddd340365f5496f25caac';
const PATCH_PAYLOAD_SHA256 = 'bedf154361e8bd23dae8173cc8ce6594fa9c38cea097c17ec18422e6e2fd67de';

/**
 * The PreToolUse guard, which has **two** legitimate states rather than one.
 *
 * `docs/pending/authority-issuance-guard.md` is a prepared patch that a human applies. Until they
 * do, the committed guard is correct; after they do, the patched one is. Reporting either as drift
 * would make this script cry wolf for however long the patch is pending, and a check people learn
 * to ignore is worse than no check.
 *
 * What *is* drift is a third value: a guard that is neither. That means someone edited it outside
 * the patch, and the digests in the patch document are stale.
 */
export const GUARD_PATH_RELATIVE = '.claude/hooks/wag-human-gate-guard.mjs';

/**
 * The guard as a human installed it on 2026-09-21, out of band.
 *
 * Exported so `test/authority-issuance-guard.test.ts` reads it from one place rather than keeping
 * a second copy of the number. The patch that produced it, and its applier, were retired once
 * applied — a pending patch that stays in the tree after it lands is a second thing to drift, which
 * is the lesson that retired the previous applier too.
 *
 * The before-digest is kept because a guard that has been *reverted* is the failure worth naming
 * precisely, rather than reporting as an anonymous mismatch.
 */
export const ISSUANCE_GUARD_SHA256 =
  '3f0787de4e0d8cf2a5df58e7f4a07a76738a82ec22097af071cd1d61a1273a61';
const GUARD_BEFORE_PATCH = 'f13670516976e7c8cfc43fdd0d263e6c860993175d10c32478fce8d83569d241';

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function main(): number {
  let drift = 0;

  out('boundary files');
  for (const file of AUTHORISED) {
    let digest: string;
    try { digest = sha256(readFileSync(join(repoRoot, file.path))); }
    catch { out(`  MISSING  ${file.path}`); drift += 1; continue; }

    if (digest === file.after) { out(`  ok       ${file.path}`); continue; }
    drift += 1;
    out(`  DRIFTED  ${file.path}`);
    out(`             now   ${digest}`);
    out(`             want  ${file.after}`);
    if (digest === file.before) {
      out('             this is the PRE-patch content: the boundary has been reverted,');
      out('             and delegated Run is permitted by code that no rule now allows.');
    }
  }

  out('');
  out('patch document');
  let raw: Buffer;
  try { raw = readFileSync(join(repoRoot, PATCH)); }
  catch { out(`  MISSING  ${PATCH}`); return drift + 1; }

  const rawDigest = sha256(raw);
  // Two digests cover this file and they are not interchangeable. `sha256sum` and `Get-FileHash`
  // cover the raw bytes; the authorised value covers the file with its own `sha256(...)` line
  // removed, because a digest cannot cover itself.
  const text = raw.toString('utf8');
  const selfDigestLines = text.match(/^sha256\([^\n]*\n/gm) ?? [];
  const payloadDigest = selfDigestLines.length === 1
    ? createHash('sha256').update(text.replace(/^sha256\([^\n]*\n/m, ''), 'utf8').digest('hex')
    : undefined;

  out(`  raw      ${rawDigest}${rawDigest === PATCH_RAW_SHA256 ? '  ok' : '  DRIFTED'}`);
  if (rawDigest !== PATCH_RAW_SHA256) drift += 1;
  if (payloadDigest === undefined) {
    out(`  payload  AMBIGUOUS: ${selfDigestLines.length} self-digest lines`);
    drift += 1;
  } else {
    out(`  payload  ${payloadDigest}${payloadDigest === PATCH_PAYLOAD_SHA256 ? '  ok' : '  DRIFTED'}`);
    if (payloadDigest !== PATCH_PAYLOAD_SHA256) drift += 1;
  }

  out('');
  out('issuance guard');
  let guardDigest: string | undefined;
  try { guardDigest = sha256(readFileSync(join(repoRoot, GUARD_PATH_RELATIVE))); }
  catch { out(`  MISSING  ${GUARD_PATH_RELATIVE}`); drift += 1; }

  if (guardDigest === ISSUANCE_GUARD_SHA256) {
    out(`  ok       ${GUARD_PATH_RELATIVE}`);
    out('           issuing or renewing a grant, and naming one in a JSON config, are refused.');
  } else if (guardDigest === GUARD_BEFORE_PATCH) {
    drift += 1;
    out(`  REVERTED ${GUARD_PATH_RELATIVE}`);
    out('           this is the pre-patch guard. Issuance has a rule and no pattern again, and');
    out('           the patch that gave it one was retired after a human applied it.');
  } else if (guardDigest !== undefined) {
    drift += 1;
    out(`  DRIFTED  ${GUARD_PATH_RELATIVE}`);
    out(`             now   ${guardDigest}`);
    out(`             want  ${ISSUANCE_GUARD_SHA256}`);
    out('             someone edited it outside the authorised patch. Read the diff.');
  }

  out('');
  out(drift === 0
    ? 'the boundary is exactly what was authorised.'
    : `${drift} file(s) differ from what was authorised. Read the diff before trusting any receipt.`);
  return drift === 0 ? 0 : 1;
}

// Guarded, because this module now exports a digest that a test imports, and importing a module
// must not run a report. `tsx scripts/verify-delegation-rule-patch.ts` still behaves exactly as
// before.
if (process.argv[1]?.split('\\').join('/').endsWith('verify-delegation-rule-patch.ts')) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
