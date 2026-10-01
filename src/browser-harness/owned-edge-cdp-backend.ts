import type {
  BrowserBackend,
  BrowserBackendSession,
  BrowserProfileHandle,
} from './browser-port.js';
import { createCdpBrowserBackend } from './cdp-browser-backend.js';
import type { CdpTransport } from './cdp-protocol.js';
import type { OwnedEdgeLauncher } from './owned-edge-launcher.js';

export function createOwnedEdgeCdpBackend(options: {
  launcher: OwnedEdgeLauncher;
  connect(endpointUrl: string): Promise<CdpTransport>;
}): BrowserBackend {
  return {
    kind: 'cdp',
    async open(profile: BrowserProfileHandle): Promise<BrowserBackendSession> {
      const launch = await options.launcher.launch(profile.owner, profile);
      const raw = createCdpBrowserBackend({
        connect: async () => options.connect(launch.plan.endpointUrl),
      });

      let session: BrowserBackendSession;
      try {
        session = await raw.open(profile);
      } catch (error) {
        await options.launcher.stop(profile.owner, launch).catch(() => undefined);
        throw error;
      }

      let closed = false;
      return {
        targetId: session.targetId,
        processId: launch.process.processId,
        pid: launch.process.pid,
        describe: () => session.describe(),
        exec: (request) => session.exec(request),
        screenshot: () => session.screenshot(),
        async close() {
          if (closed) return;
          closed = true;
          let failure: unknown;
          try {
            await session.close();
          } catch (error) {
            failure = error;
          }
          try {
            await options.launcher.stop(profile.owner, launch);
          } catch (error) {
            failure ??= error;
          }
          if (failure) throw failure;
        },
      };
    },
  };
}
