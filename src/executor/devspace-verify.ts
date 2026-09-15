import type { DevspaceExecutor } from './devspace.js';
import type { VerifyExecutionEvidence, VerifyExecutionPort } from '../verify-execution-port.js';
import type { ResolvedVerifyProfile } from '../verify-profile.js';

type VerifyDevspaceExecutor = Pick<
  DevspaceExecutor,
  'openWorkspace' | 'execCommand' | 'interruptCommand'
>;

export class DevspaceVerifyExecutionPort implements VerifyExecutionPort {
  readonly kind = 'devspace';

  constructor(private readonly executor: VerifyDevspaceExecutor) {}

  async execute(canonicalRoot: string, profile: ResolvedVerifyProfile): Promise<VerifyExecutionEvidence> {
    const workspaceId = await this.executor.openWorkspace(canonicalRoot);
    const result = await this.executor.execCommand(
      workspaceId, profile.command, profile.maxOutputTokens, profile.timeoutMs,
    );
    if (!result.running) {
      return { status: 'completed', exitCode: result.exitCode ?? -1, output: result.output };
    }
    if (result.sessionId !== undefined) {
      await this.executor.interruptCommand(workspaceId, result.sessionId, profile.maxOutputTokens).catch(() => undefined);
    }
    return { status: 'unconfirmed', errorClass: 'EXECUTION_TIMEOUT_UNCONFIRMED' };
  }
}
