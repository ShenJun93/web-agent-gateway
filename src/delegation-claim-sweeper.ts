/**
 * Retire claims that never reached dispatch (ADR-0029).
 *
 * `claimDelegatedDispatch` and `markDelegatedDispatched` are two transactions, not one, because the
 * thing between them is a tool run and a transaction cannot span it. A crash in that window leaves
 * a row stuck in `CLAIMED`: the slot is spent, and nothing will ever move the row forward, because
 * every transition is single-assignment and the process that owned it is gone.
 *
 * `abandonExpiredClaims` retires those rows — and the store has always had it. What it did not have
 * was a caller. Measured on this tree before this file existed: no production module referenced it,
 * so a crash between CLAIM and DISPATCH stranded a `CLAIMED` row permanently. The budget arithmetic
 * stayed correct (the slot really was spent) but the row never reached a terminal state, so an
 * operator reading the audit could not tell "in flight" from "died three hours ago".
 *
 * ## What abandonment does not do
 *
 * It does **not** refund the slot, and it does not re-run anything. WAG cannot know whether the
 * dispatch that was in flight reached a tool, so the only honest resolution is the pessimistic one:
 * the action counted, and the proposal is terminal without ever having produced a result. A sweeper
 * that gave the slot back would turn a crash into a way to exceed `maxActions`.
 *
 * It also never touches `DISPATCHED` rows. Those reached a tool; their story ends at
 * `RESULTED` or at a visibly unfinished row, and abandoning them would claim knowledge nobody has.
 */
import { CLAIM_TTL_MS } from './goal-ui-delegation-dispatch.js';

/** How often the sweep runs. Cheap — one indexed UPDATE that usually changes nothing. */
export const CLAIM_SWEEP_INTERVAL_MS = 30_000;

/** Exactly what the sweeper may do to the store: retire stale claims, and nothing else. */
export interface ClaimSweepPort {
  abandonExpiredClaims(now: number, claimTtlMs: number): number;
}

export interface ClaimSweeperOptions {
  port: ClaimSweepPort;
  now?: () => number;
  claimTtlMs?: number;
  intervalMs?: number;
  /** Called with the number of rows retired, when it is not zero. For the runtime's stderr. */
  onSwept?(abandoned: number): void;
}

/**
 * A timer that retires stale claims, plus the single-pass function it calls.
 *
 * The pass is exported and runs on construction as well as on the interval: the window this exists
 * for is a *crash*, so the rows that most need retiring are the ones already on disk when the
 * process starts. Waiting a full interval to notice them would leave the first thirty seconds after
 * every restart looking exactly like the bug.
 */
export class DelegationClaimSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly claimTtlMs: number;
  private readonly intervalMs: number;

  constructor(private readonly options: ClaimSweeperOptions) {
    this.now = options.now ?? Date.now;
    this.claimTtlMs = options.claimTtlMs ?? CLAIM_TTL_MS;
    this.intervalMs = options.intervalMs ?? CLAIM_SWEEP_INTERVAL_MS;
  }

  /** One pass. Returns how many rows were retired. Never throws: a failed sweep is not fatal. */
  sweep(): number {
    try {
      const abandoned = this.options.port.abandonExpiredClaims(this.now(), this.claimTtlMs);
      if (abandoned > 0) this.options.onSwept?.(abandoned);
      return abandoned;
    } catch {
      // A sweep that cannot run must not take down a runtime whose human route is working fine.
      // The rows stay `CLAIMED` and the next pass tries again; nothing is lost by failing quietly
      // here, because nothing here is what makes the budget correct.
      return 0;
    }
  }

  /** Sweep now, then on the interval. `unref` so it never holds the process open. */
  start(): void {
    if (this.timer) return;
    this.sweep();
    this.timer = setInterval(() => { this.sweep(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
