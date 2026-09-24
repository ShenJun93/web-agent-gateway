import type { GatewayAuthority } from './caller-context.js';
import {
  HarnessEffectLedger,
  type HarnessEffectPlan,
  type HarnessEffectRecord,
} from './harness-effect-ledger.js';

export type HarnessEffectExecutionResult =
  | { readonly status: 'CONFIRMED_SUCCESS'; readonly resultDigest: string }
  | { readonly status: 'NO_EFFECT'; readonly errorClass: string }
  | { readonly status: 'OUTCOME_UNKNOWN'; readonly errorClass: string };

export interface HarnessEffectExecutionContext {
  readonly effectId: string;
  readonly attemptId: string;
}

export class HarnessEffectCoordinator {
  constructor(private readonly ledger: HarnessEffectLedger) {}

  async execute(
    owner: GatewayAuthority,
    idempotencyKey: string,
    plan: HarnessEffectPlan,
    executor: (context: HarnessEffectExecutionContext) => Promise<HarnessEffectExecutionResult>,
  ): Promise<HarnessEffectRecord> {
    const reserved = this.ledger.reserve(owner, idempotencyKey, plan);
    const claim = this.ledger.claim(owner, reserved.effectId);
    if (!claim.claimed) return claim.record;
    const attemptId = claim.record.attemptId;
    if (!attemptId) {
      this.ledger.markOutcomeUnknown(owner, reserved.effectId, 'MISSING_ATTEMPT_ID');
      throw new Error('Harness effect claim returned no attempt id');
    }

    let result: HarnessEffectExecutionResult;
    try {
      result = await executor({ effectId: reserved.effectId, attemptId });
    } catch (error) {
      this.ledger.markOutcomeUnknown(owner, reserved.effectId, 'EXECUTOR_THROW');
      throw error;
    }

    switch (result.status) {
      case 'CONFIRMED_SUCCESS':
        return this.ledger.confirmSuccess(owner, reserved.effectId, result.resultDigest);
      case 'NO_EFFECT':
        return this.ledger.failNoEffect(owner, reserved.effectId, result.errorClass);
      case 'OUTCOME_UNKNOWN':
        return this.ledger.markOutcomeUnknown(owner, reserved.effectId, result.errorClass);
    }
  }
}
