import type { GatewayAuthority } from './caller-context.js';

/**
 * A per-caller attempt window for proposal creation.
 *
 * The live-pending caps count *records*, which is the right bound on how much the operator's
 * review list can hold. It is the wrong bound on how much work a caller can cause, because a
 * proposal that fails while being computed creates no record: an independent review showed that
 * three hundred `git.commit` proposals naming unchanged paths ran the planner three hundred
 * times and left the counter at zero, each run spawning a dozen git subprocesses and reading
 * every selected file.
 *
 * So attempts are counted before the work, not records after it. The window is in memory on
 * purpose: this bounds how fast one caller can drive local work, and a process restart is not
 * something an attacker gains anything from.
 */
export interface ProposalRateLimit {
  /** Throws when this caller has spent its budget; records the attempt otherwise. */
  charge(authority: GatewayAuthority, now: number): void;
}

export const DEFAULT_PROPOSAL_ATTEMPTS = 30;
export const DEFAULT_PROPOSAL_WINDOW_MS = 60_000;

export function createProposalRateLimit(options: {
  attempts?: number;
  windowMs?: number;
  message?: string;
} = {}): ProposalRateLimit {
  const attempts = options.attempts ?? DEFAULT_PROPOSAL_ATTEMPTS;
  const windowMs = options.windowMs ?? DEFAULT_PROPOSAL_WINDOW_MS;
  const message = options.message ?? 'Gateway denied proposal: too many attempts';
  const byCaller = new Map<string, number[]>();

  return {
    charge(authority, now) {
      const key = [authority.ownerId, authority.sessionId, authority.adapterId].join('\0');
      const recent = (byCaller.get(key) ?? []).filter((at) => at > now - windowMs);
      if (recent.length >= attempts) {
        // Keep the window as it is: a refused attempt must not extend the penalty, and must not
        // be free either, or a caller could spin on refusals.
        byCaller.set(key, recent);
        throw new Error(message);
      }
      recent.push(now);
      byCaller.set(key, recent);

      // Callers come and go; nothing else prunes this map.
      if (byCaller.size > 1_024) {
        for (const [otherKey, timestamps] of byCaller) {
          if (timestamps.every((at) => at <= now - windowMs)) byCaller.delete(otherKey);
        }
      }
    },
  };
}
