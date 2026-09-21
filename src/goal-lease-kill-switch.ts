/**
 * The local emergency stop for autonomous admission (ADR-0028, requirement 11).
 *
 * A file, deliberately. Not a row in the durable store and not a flag in a config the runtime
 * parsed at startup, because the situation this exists for is the one where those are not
 * working or not trusted: the store is locked, the runtime is mid-something, or the operator
 * simply wants everything to stop *now* and does not want to reason about whether it will.
 *
 * Properties that follow from it being a file:
 *
 *   - it can be engaged by anything that can create a file, including a human with a file
 *     manager, with no WAG process cooperating;
 *   - it takes effect on the very next admission, because it is checked per call rather than
 *     cached;
 *   - it survives a restart, so a stop is not quietly undone by the thing that was misbehaving;
 *   - it fails *engaged*. If the check itself throws — permissions, a path that is somehow a
 *     directory, an I/O error — this reports engaged. An emergency stop that fails open is not
 *     an emergency stop.
 *
 * It does not revoke anything. A lease survives the switch being engaged and resumes when it is
 * cleared, which is the intended difference: revocation is a decision, this is a pause.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const KILL_SWITCH_FILE = 'LEASE_AUTONOMY_STOPPED';

/** The directory WAG keeps its state in. Fails closed if the environment cannot name it. */
export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) {
    throw new Error('LOCALAPPDATA is not an absolute path, so the WAG state directory cannot be located');
  }
  return join(localAppData, 'WebAgentGateway');
}

/**
 * Whether autonomous admission is currently stopped.
 *
 * Wrapped so that *any* failure reads as engaged. The alternative — letting an unreadable switch
 * mean "not stopped" — turns a permissions problem into a silent resumption of autonomy.
 */
export function isKillSwitchEngaged(directory: string): boolean {
  try {
    return existsSync(join(directory, KILL_SWITCH_FILE));
  } catch {
    return true;
  }
}

/** Engage the stop. Idempotent; writing it twice is not an error. */
export function engageKillSwitch(directory: string, reason: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, KILL_SWITCH_FILE);
  // The body is for the human who finds it later, and is never parsed — nothing branches on it,
  // so a corrupted or empty file still stops autonomy exactly as well.
  writeFileSync(path, `${new Date().toISOString()}\n${reason}\n`, 'utf8');
  return path;
}

/** Clear the stop. Returns whether one was actually present. */
export function clearKillSwitch(directory: string): boolean {
  const path = join(directory, KILL_SWITCH_FILE);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
