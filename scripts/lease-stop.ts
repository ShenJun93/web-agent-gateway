/**
 * Engage or clear the local emergency stop for autonomous admission (ADR-0028).
 *
 *   npm run lease:stop            engage, with a default reason
 *   npm run lease:stop -- "why"   engage, recording why
 *   npm run lease:stop -- --clear clear it
 *   npm run lease:stop -- --status report without changing anything
 *
 * Engaging stops every Goal Lease admission **and every delegated Run** on the next call, in every
 * WAG process on this machine, without needing any of them to cooperate. One switch covers both
 * because someone reaching for the stop wants autonomy halted, not a quiz about which of the two
 * authorities is running — and ADR-0029 reuses this file rather than adding a second one nobody
 * would remember in an emergency.
 *
 * It revokes nothing: both resume when it is cleared. To end either permanently, revoke the row.
 *
 * It deliberately does **not** block the human route. Someone stopping runaway automation must
 * still be able to click Run and Approve themselves.
 */
import {
  clearKillSwitch, engageKillSwitch, isKillSwitchEngaged, KILL_SWITCH_FILE, stateDirectory,
} from '../src/goal-lease-kill-switch.js';

function main(): number {
  const args = process.argv.slice(2);
  const directory = stateDirectory();

  if (args.includes('--status')) {
    const engaged = isKillSwitchEngaged(directory);
    console.log(`autonomous admission : ${engaged ? 'STOPPED' : 'allowed'}  (Goal Lease approval and delegated Run)`);
    console.log(`switch file          : ${directory}\\${KILL_SWITCH_FILE}`);
    return engaged ? 1 : 0;
  }

  if (args.includes('--clear')) {
    const cleared = clearKillSwitch(directory);
    console.log(cleared
      ? 'cleared : autonomous admission may resume for leases and delegations that are still valid'
      : 'nothing to clear : autonomous admission was not stopped');
    return 0;
  }

  const reason = args.find((a) => !a.startsWith('--')) ?? 'engaged from the command line';
  const path = engageKillSwitch(directory, reason);
  console.log('STOPPED : every Goal Lease admission and every delegated Run will now be refused,');
  console.log('          on the next call. The human Run and Approve routes are untouched.');
  console.log(`switch  : ${path}`);
  console.log('note    : this pauses; it does not revoke. Clear it with --clear.');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
