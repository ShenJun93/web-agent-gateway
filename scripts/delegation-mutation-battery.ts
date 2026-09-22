/**
 * The Goal UI Delegation mutation battery, runnable from the repository.
 *
 * An adversarial review pointed out that the previous receipt claimed "33 applied, 30 caught"
 * with no script, no target and no list committed — a number nobody else could check. This is
 * that script. `scripts/delegation-mutations.json` is the list, exported verbatim from the run
 * the receipt describes.
 *
 * Each entry breaks exactly one guard and names the suite that must notice. A guard whose
 * mutation still passes is a guard no test reaches, which is the defect class every prior
 * security review of this project found.
 *
 * A name prefixed `REDUNDANT ` is *expected* to survive, and each one has a stated reason:
 *
 *  - the five store mutations are early state reads that the single-assignment `UPDATE` in the
 *    same transaction also covers, kept as backstops against a change to the isolation level;
 *  - the router mutation substituting the envelope's session for the connection's is unobservable
 *    because `handle` compares the two and refuses a mismatch *before* reaching that call, so at
 *    that point they are provably equal. The comparison itself has its own mutation, and it is
 *    caught.
 *
 * For the store five, the redundancy is measured rather than asserted: a second connection's
 * `BEGIN IMMEDIATE` is refused in about a millisecond while one is open, and `BEGIN DEFERRED` is
 * granted — so the lock carries the property and these are the layers that survive it being
 * weakened. A mutation changing the isolation level itself is in the list and must be CAUGHT.
 *
 * Sources are restored in a `finally`, because two earlier runs of an equivalent script were
 * interrupted and left the tree mutated.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Mutation {
  readonly name: string;
  readonly file: string;
  readonly suite: string;
  readonly from: string;
  readonly to: string;
}

type Verdict = 'CAUGHT' | 'SURVIVED' | 'REDUNDANT' | 'NOT-APPLIED' | 'INCONCLUSIVE';

/**
 * Run one suite against the mutated tree and report what actually happened.
 *
 * The distinction between `failed` and `didNotRun` is the point. A review noted that treating any
 * non-zero exit as a catch would score a mutation that merely broke the file — the suite never
 * ran, so it never noticed anything, and counting that as a catch would inflate the measure with
 * exactly the mutations that prove least. A run that reported no tests at all is inconclusive and
 * is reported as such.
 */
function runSuite(suite: string): { failed: boolean; ranTests: number } {
  let stdout = '';
  let failed = false;
  try {
    // `node --import tsx` rather than `npx tsx`: no shell, so the arguments are passed as an
    // argument vector instead of being concatenated into a command line. `npx` on Windows needs a
    // shell, and `shell: true` with an args array is the shape that concatenates.
    stdout = execFileSync(process.execPath, ['--import', 'tsx', '--test', suite], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
    });
  } catch (error) {
    failed = true;
    stdout = String((error as { stdout?: string }).stdout ?? '');
  }
  const reported = /^. tests (\d+)$/m.exec(stdout);
  return { failed, ranTests: reported ? Number(reported[1]) : 0 };
}

function main(): void {
  const mutations = JSON.parse(
    readFileSync(join(repoRoot, 'scripts', 'delegation-mutations.json'), 'utf8'),
  ) as Mutation[];

  const files = [...new Set(mutations.map((m) => m.file))];
  const originals = new Map(files.map((f) => [f, readFileSync(join(repoRoot, f), 'utf8')]));
  const results: Array<{ name: string; verdict: Verdict }> = [];

  try {
    for (const mutation of mutations) {
      const source = originals.get(mutation.file);
      if (source === undefined) throw new Error(`no source for ${mutation.file}`);
      const occurrences = source.split(mutation.from).length - 1;
      if (occurrences !== 1) {
        results.push({ name: mutation.name, verdict: 'NOT-APPLIED' });
        process.stdout.write(`!!  NOT-APPLIED  ${mutation.name} (${occurrences} matches)\n`);
        continue;
      }
      writeFileSync(join(repoRoot, mutation.file), source.replace(mutation.from, mutation.to));
      const outcome = runSuite(mutation.suite);
      writeFileSync(join(repoRoot, mutation.file), source);

      const redundant = mutation.name.startsWith('REDUNDANT ');
      let verdict: Verdict;
      if (outcome.ranTests === 0) {
        // The suite never ran, so it never noticed anything. Scoring this as a catch would credit
        // the mutation that proves least.
        verdict = 'INCONCLUSIVE';
      } else if (outcome.failed) {
        verdict = 'CAUGHT';
      } else {
        verdict = redundant ? 'REDUNDANT' : 'SURVIVED';
      }
      results.push({ name: mutation.name, verdict });
      const mark = verdict === 'CAUGHT' ? 'ok ' : (verdict === 'REDUNDANT' ? '-- ' : 'XX ');
      process.stdout.write(`${mark} ${verdict.padEnd(12)} ${mutation.name}\n`);
    }
  } finally {
    for (const [file, source] of originals) writeFileSync(join(repoRoot, file), source);
    process.stdout.write('\nsources restored\n');
  }

  const caught = results.filter((r) => r.verdict === 'CAUGHT').length;
  const redundant = results.filter((r) => r.verdict === 'REDUNDANT').length;
  process.stdout.write(`\n${caught} caught, ${redundant} redundant-by-design, ${results.length} total\n`);

  const bad = results.filter((r) => r.verdict !== 'CAUGHT' && r.verdict !== 'REDUNDANT');
  if (bad.length > 0) {
    process.stdout.write('NOT CAUGHT:\n');
    for (const r of bad) process.stdout.write(`  ${r.verdict}: ${r.name}\n`);
    process.exitCode = 1;
  }
}

main();
