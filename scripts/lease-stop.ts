/**
 * Engage or clear the local emergency stop for autonomous admission (ADR-0028).
 *
 *   npm run lease:stop            engage, with a default reason
 *   npm run lease:stop -- "why"   engage, recording why
 *   npm run lease:stop -- --clear clear it
 *   npm run lease:stop -- --status report without changing anything
 *
 * Engaging stops every Goal Lease admission on the next call, in every WAG process on this
 * machine, without needing any of them to cooperate. It revokes nothing: leases resume when it
 * is cleared. To end a lease permanently, revoke the lease.
 */
import {
  clearKillSwitch, engageKillSwitch, isKillSwitchEngaged, KILL_SWITCH_FILE, stateDirectory,
} from '../src/goal-lease-kill-switch.js';

function main(): number {
  const args = process.argv.slice(2);
  const directory = stateDirectory();

  if (args.includes('--status')) {
    const engaged = isKillSwitchEngaged(directory);
    console.log(`autonomous admission : ${engaged ? 'STOPPED' : 'allowed'}`);
    console.log(`switch file          : ${directory}\\${KILL_SWITCH_FILE}`);
    return engaged ? 1 : 0;
  }

  if (args.includes('--clear')) {
    const cleared = clearKillSwitch(directory);
    console.log(cleared
      ? 'cleared : autonomous admission may resume for leases that are still valid'
      : 'nothing to clear : autonomous admission was not stopped');
    return 0;
  }

  const reason = args.find((a) => !a.startsWith('--')) ?? 'engaged from the command line';
  const path = engageKillSwitch(directory, reason);
  console.log('STOPPED : every Goal Lease admission will now be refused, on the next call');
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
