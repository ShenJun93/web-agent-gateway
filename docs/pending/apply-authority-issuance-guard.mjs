/**
 * Apply the authority-issuance guard patch — **for a human to run**.
 *
 * Claude cannot run this and cannot perform the edit it performs: `.claude/settings.json` denies
 * Claude's writes under `.claude/`, which is the point. This script exists so that the human's
 * action can be exact rather than manual, and so that a mistake fails closed instead of leaving a
 * half-patched guard behind.
 *
 * ```bash
 * node docs/pending/apply-authority-issuance-guard.mjs --check   # writes nothing, reports
 * node docs/pending/apply-authority-issuance-guard.mjs --apply   # writes, then re-verifies
 * ```
 *
 * ## Why this lives in docs/pending and not in scripts/
 *
 * An earlier applier was retired for keeping a second copy of a `.claude/rules/` file in
 * `scripts/`, where it would live forever and drift. This one is transient by construction: it
 * belongs to a patch that is pending, and it is deleted with the patch once applied. What stays
 * behind afterwards is a digest check in `scripts/verify-delegation-rule-patch.ts`, which carries
 * no guard text at all.
 *
 * ## Fail-closed, specifically
 *
 * - the guard must hash to `EXPECTED_BEFORE` exactly, or nothing is written;
 * - every anchor must occur exactly once, or nothing is written;
 * - after writing, the result is re-read from disk and must hash to `EXPECTED_AFTER`, or the
 *   original is restored and the exit code is non-zero;
 * - `--check` never opens the file for writing.
 *
 * `REPLACEMENTS` is exported so that `test/authority-issuance-guard.test.ts` can apply the same
 * table in memory and **execute** the resulting guard. That is deliberate: it means the regression
 * tests run against the exact bytes a human would install, and cannot drift from them.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const GUARD_PATH = fileURLToPath(
  new URL('../../.claude/hooks/wag-human-gate-guard.mjs', import.meta.url),
);

/** The guard as committed, before this patch. */
export const EXPECTED_BEFORE = 'f13670516976e7c8cfc43fdd0d263e6c860993175d10c32478fce8d83569d241';

/** The guard after it. Recomputed by `--check`, so a drifted table is visible rather than silent. */
export const EXPECTED_AFTER = '3f0787de4e0d8cf2a5df58e7f4a07a76738a82ec22097af071cd1d61a1273a61';

/**
 * Anchored replacements, applied in order. Each `from` must appear exactly once.
 *
 * Kept as whole-line anchors rather than line numbers so the patch survives an unrelated edit
 * above it, and so a failure reports *which* anchor moved rather than producing a mangled file.
 */
export const REPLACEMENTS = [
  {
    name: 'the issuance surfaces',
    from: `const BOUNDARY_RULE = 'See .claude/rules/human-presence-boundary.md.';`,
    to: `/**
 * Minting an authority that removes a human gesture, or naming one in local configuration.
 *
 * A Goal Lease lifts Approve (ADR-0028); a Goal UI Delegation lifts Run (ADR-0029). Both rules say
 * the same thing in the same words — issuance is human-only and out of band, Claude may *use* a
 * grant and must *report* on one but may never create, widen or renew one — and until this block
 * that was the only rule in \`human-presence-boundary.md\` with no pattern behind it anywhere.
 *
 * Two acts are refused, because there are two ways a shell reaches authority:
 *
 *   1. **running** issuance — the control CLI with an issuing flag, or a one-liner that calls the
 *      store or the control plane directly;
 *   2. **naming** a grant in local configuration — which is the quieter half and the one that
 *      actually matters. A delegation not named in config is inert whatever its row says, so
 *      writing the name is the act that turns a row into live authority.
 *
 * Deliberately **not** refused: \`--show\`, \`--sessions\`, \`--workspaces\`, every read of any of
 * these files, \`--revoke\`, and \`npm run lease:stop\`. Narrowing a grant and stopping automation
 * are things a person may need help with in a hurry, and a guard that refused them is a guard
 * people learn to turn off.
 */
const GRANT_CLI = /\\bdelegation-control(?:\\.[cm]?[jt]s)?\\b/i;
const GRANT_CLI_FLAG = /--(?:issue|renew)\\b/;
/** A *call*, not a mention: the open bracket is what separates invoking from describing. */
const GRANT_CALL =
  /\\b(?:insertUiDelegation|renewUiDelegation|insertGoalLease)\\s*\\(|\\bnew\\s+UiDelegationControlPlane\\s*\\(/;
/** The two configuration fields that turn a durable row into authority this process will honour. */
const GRANT_CONFIG_FIELD = /\\b(?:goalUiDelegationId|goalLeaseId)\\b/;
/** Something that *runs* a script, as opposed to reading, grepping or quoting one. */
const SCRIPT_RUNNER = /\\b(?:node|npx|npm|pnpm|yarn|bun|deno|tsx|ts-node)\\b/i;

const BOUNDARY_RULE = 'See .claude/rules/human-presence-boundary.md.';`,
  },
  {
    name: 'the matchers',
    from: `function matchRunSurface(text) {
  for (const [pattern, why] of RUN_SURFACE) if (pattern.test(text)) return why;
  return undefined;
}`,
    to: `function matchRunSurface(text) {
  for (const [pattern, why] of RUN_SURFACE) if (pattern.test(text)) return why;
  return undefined;
}

/**
 * A shell command that mints or renews a grant.
 *
 * A runner is required for the same reason \`BROWSER_DRIVER\` is required beside the Run surface:
 * \`grep -- --issue scripts/delegation-control.ts\` is reading about issuance, not performing it,
 * and a guard that refused reading would be refusing the review of itself.
 */
function matchAuthorityIssuance(text) {
  if (!SCRIPT_RUNNER.test(text)) return undefined;
  if (GRANT_CLI.test(text) && GRANT_CLI_FLAG.test(text)) {
    return 'issues or renews a Goal UI Delegation';
  }
  if (GRANT_CALL.test(text)) return 'calls delegation or lease issuance directly';
  return undefined;
}

/**
 * A write that hands Claude an authority rather than describing one.
 *
 * Scoped to JSON, which is what a private gateway config is. It is deliberately **not** extended
 * to source files that merely contain these names: \`durable-store.ts\` defines the insert,
 * \`goal-ui-delegation-dispatch.ts\` discusses it in a comment, and refusing those would refuse
 * ordinary work and the analysis of this boundary alike — the same over-match that once refused a
 * commit message for quoting a filename. What a text rule can say precisely is "this JSON names a
 * grant", and that is the act that makes a row live.
 */
function matchAuthorityWrite(input) {
  const target = input && typeof input === 'object'
    ? input.file_path ?? input.notebook_path
    : undefined;
  if (typeof target !== 'string') return undefined;
  if (!/\\.json$/i.test(target.split('\\\\').join('/'))) return undefined;
  return GRANT_CONFIG_FIELD.test(serialize(input))
    ? 'names a Goal Lease or a Goal UI Delegation in a configuration file'
    : undefined;
}`,
  },
  {
    name: 'the writer branch',
    from: `  if (tool.startsWith('mcp__computer-use__')) {`,
    to: `  // Naming a grant in config is proposing to grant Claude authority, so it is the operator's
  // edit to make. Checked after the hook-directory rule because that one is the narrower target.
  if (WRITERS.has(tool)) {
    const why = matchAuthorityWrite(event?.tool_input);
    if (why) {
      return {
        deny: true,
        reason: \`wag-human-gate-guard: this write \${why}. A delegation or lease that is not named in local configuration is inert, so writing the name is what turns a row into live authority — and issuance is human-only and out of band. \${BOUNDARY_RULE}\`,
      };
    }
  }

  if (tool.startsWith('mcp__computer-use__')) {`,
  },
  {
    name: 'the shell branch',
    from: `  if (tool === 'Bash' || tool === 'PowerShell') {`,
    to: `  if (tool === 'Bash' || tool === 'PowerShell') {
    const issuing = matchAuthorityIssuance(text);
    if (issuing) {
      return {
        deny: true,
        reason: \`wag-human-gate-guard: this command \${issuing}. Claude may use a Goal Lease or a Goal UI Delegation and must report on one; it may not create, widen or renew one. Revocation and \\\`npm run lease:stop\\\` are not refused. \${BOUNDARY_RULE}\`,
      };
    }`,
  },
];

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Apply the table in memory. Throws on any anchor that is absent or ambiguous. */
export function applyReplacements(source) {
  let text = source;
  for (const { name, from, to } of REPLACEMENTS) {
    const occurrences = text.split(from).length - 1;
    if (occurrences !== 1) {
      throw new Error(`anchor "${name}" occurs ${occurrences} times, expected exactly 1`);
    }
    text = text.replace(from, to);
  }
  return text;
}

async function main() {
  const mode = process.argv.includes('--apply') ? 'apply' : 'check';
  const original = await readFile(GUARD_PATH, 'utf8');
  const before = sha256(original);

  console.log(`guard        ${GUARD_PATH}`);
  console.log(`before       ${before}`);
  console.log(`expected     ${EXPECTED_BEFORE}`);

  if (before === EXPECTED_AFTER) {
    console.log('\nALREADY APPLIED — the guard already hashes to the expected result.');
    return 0;
  }
  if (before !== EXPECTED_BEFORE) {
    console.error('\nREFUSING: the guard is neither the expected before nor the expected after.');
    console.error('Someone has edited it. Review the difference before applying anything.');
    return 2;
  }

  let patched;
  try {
    patched = applyReplacements(original);
  } catch (error) {
    console.error(`\nREFUSING: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const after = sha256(patched);
  console.log(`after        ${after}`);
  console.log(`expected     ${EXPECTED_AFTER}`);
  if (after !== EXPECTED_AFTER) {
    console.error('\nREFUSING: the patched result does not match the authorised digest.');
    return 2;
  }

  if (mode === 'check') {
    console.log('\nOK — would apply cleanly. Nothing was written. Re-run with --apply.');
    return 0;
  }

  await writeFile(GUARD_PATH, patched, 'utf8');
  const written = sha256(await readFile(GUARD_PATH, 'utf8'));
  if (written !== EXPECTED_AFTER) {
    await writeFile(GUARD_PATH, original, 'utf8');
    console.error(`\nREFUSING: wrote ${written}, restored the original.`);
    return 2;
  }
  console.log('\nAPPLIED.');
  console.log('Now run:  npx tsx --test test/authority-issuance-guard.test.ts');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]?.split('\\').join('/')}`
  || process.argv[1]?.endsWith('apply-authority-issuance-guard.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
}
