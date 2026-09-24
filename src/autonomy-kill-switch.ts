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
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * `statSync` with `throwIfNoEntry: false`, *not* `existsSync`. This distinction is the whole
 * behaviour: `existsSync` swallows every error and returns `false`, so a switch file that exists
 * but cannot be stat'd — a restrictive ACL, a transient lock, an invalid path — read as "not
 * stopped" and autonomy continued. A review measured it: a file that exists and is
 * access-denied returned `false`, and the `catch` arm this function used to carry was
 * unreachable code sitting under a comment claiming it was the safety property.
 *
 * With `throwIfNoEntry: false`, absence returns `undefined` and every *other* failure throws, so
 * the three cases are finally distinct:
 *
 *   present   -> engaged
 *   absent    -> not engaged
 *   unknowable-> engaged
 *
 * An emergency stop that fails open is not an emergency stop.
 */
export function isKillSwitchEngaged(directory: string): boolean {
  try {
    return statSync(join(directory, KILL_SWITCH_FILE), { throwIfNoEntry: false }) !== undefined;
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
