import type { GatewayAuthority } from '../caller-context.js';
import type { ProcessHandle, ProcessPort } from '../process-harness/process-port.js';
import type { BrowserProfileHandle } from './browser-port.js';
import { createEdgeCdpLaunchPlan, type EdgeCdpLaunchPlan } from './edge-launch-plan.js';

export interface OwnedEdgeLaunch {
  readonly plan: EdgeCdpLaunchPlan;
  readonly process: ProcessHandle;
}

export interface OwnedEdgeLauncher {
  launch(owner: GatewayAuthority, profile: BrowserProfileHandle): Promise<OwnedEdgeLaunch>;
  stop(owner: GatewayAuthority, launch: OwnedEdgeLaunch): Promise<ProcessHandle>;
}

export function createOwnedEdgeLauncher(options: {
  processPort: ProcessPort;
  executablePath: string;
  allocateDebugPort(): Promise<number>;
  initialUrl?: string;
  extraArgs?: readonly string[];
  waitUntilReady(endpointUrl: string, timeoutMs: number): Promise<void>;
  readyTimeoutMs?: number;
}): OwnedEdgeLauncher {
  return {
    async launch(owner, profile) {
      const debugPort = await options.allocateDebugPort();
      const plan = createEdgeCdpLaunchPlan({
        executablePath: options.executablePath,
        profile,
        debugPort,
        ...(options.initialUrl === undefined ? {} : { initialUrl: options.initialUrl }),
        ...(options.extraArgs === undefined ? {} : { extraArgs: options.extraArgs }),
      });
      const process = await options.processPort.start(owner, {
        argv: [plan.executablePath, ...plan.argv],
        cwd: profile.userDataDir,
      });
      try {
        await options.waitUntilReady(plan.endpointUrl, options.readyTimeoutMs ?? 15_000);
      } catch (error) {
        await options.processPort.stop(owner, process.processId).catch(() => undefined);
        throw error;
      }
      return Object.freeze({ plan, process });
    },

    stop(owner, launch) {
      return options.processPort.stop(owner, launch.process.processId);
    },
  };
}
