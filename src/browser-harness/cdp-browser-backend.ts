import type {
  BrowserBackend,
  BrowserBackendSession,
  BrowserExecRequest,
  BrowserProfileHandle,
} from './browser-port.js';
import { CdpProtocolClient, type CdpTransport } from './cdp-protocol.js';

interface TargetInfo {
  targetId: string;
  type?: string;
  url?: string;
  title?: string;
}

interface TargetList {
  targetInfos?: TargetInfo[];
}

interface AttachResult {
  sessionId?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function targetList(value: unknown): TargetInfo[] {
  const values = object(value).targetInfos;
  if (!Array.isArray(values)) return [];
  return values.filter((item): item is TargetInfo => typeof item === 'object' && item !== null
    && typeof (item as TargetInfo).targetId === 'string');
}

export function createCdpBrowserBackend(options: {
  connect(profile: BrowserProfileHandle): Promise<CdpTransport>;
}): BrowserBackend {
  return {
    kind: 'cdp',
    async open(profile) {
      const transport = await options.connect(profile);
      const browser = new CdpProtocolClient(transport);
      let page: TargetInfo;
      let pageClient: CdpProtocolClient;
      try {
        const targets = targetList(await browser.call('Target.getTargets') as TargetList);
        const selected = targets.find((target) => target.type === 'page');
        if (!selected) throw new Error('CDP browser has no page target');
        page = selected;
        const attach = object(await browser.call('Target.attachToTarget', {
          targetId: page.targetId,
          flatten: true,
        })) as AttachResult;
        if (typeof attach.sessionId !== 'string' || attach.sessionId.length === 0) {
          throw new Error('CDP target attach did not return a session id');
        }
        pageClient = new CdpProtocolClient(transport, attach.sessionId);
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }

      const session: BrowserBackendSession = {
        targetId: page.targetId,
        async describe() {
          const list = targetList(await browser.call('Target.getTargets') as TargetList);
          const current = list.find((target) => target.targetId === page.targetId);
          if (!current) throw new Error('CDP page target disappeared');
          return { url: current.url ?? '', title: current.title ?? '' };
        },
        async exec(request: BrowserExecRequest) {
          return pageClient.call(request.method, request.params);
        },
        async screenshot() {
          const result = object(await pageClient.call('Page.captureScreenshot', { format: 'png' }));
          if (typeof result.data !== 'string') throw new Error('CDP screenshot did not return PNG data');
          return { mimeType: 'image/png' as const, dataBase64: result.data };
        },
        async close() {
          try {
            await browser.call('Target.closeTarget', { targetId: page.targetId });
          } finally {
            await browser.close();
          }
        },
      };
      return session;
    },
  };
}
