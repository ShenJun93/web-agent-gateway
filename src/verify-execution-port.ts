import type { ResolvedVerifyProfile } from './verify-profile.js';

export type VerifyExecutionEvidence =
  | { status: 'completed'; exitCode: number; output: string }
  | { status: 'unconfirmed'; errorClass: 'EXECUTION_TIMEOUT_UNCONFIRMED' };

export interface VerifyExecutionPort {
  readonly kind: string;
  execute(canonicalRoot: string, profile: ResolvedVerifyProfile): Promise<VerifyExecutionEvidence>;
}
