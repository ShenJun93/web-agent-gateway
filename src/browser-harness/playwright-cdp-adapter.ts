import type {
  BrowserBackend,
  BrowserBackendSession,
  BrowserExecRequest,
  BrowserProfileHandle,
} from './browser-port.js';

export interface PlaywrightCdpSessionLike {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  detach(): Promise<void>;
}

export interface PlaywrightPageLike {
  url(): string;
  title(): Promise<string>;
  screenshot(options?: { type?: 'png' }): Promise<Uint8Array>;
}

export interface PlaywrightBrowserContextLike {
  pages(): PlaywrightPageLike[];
  newCDPSession(page: PlaywrightPageLike): Promise<PlaywrightCdpSessionLike>;
}

export interface PlaywrightBrowserLike {
  contexts(): PlaywrightBrowserContextLike[];
  close(): Promise<void>;
}

export interface PlaywrightChromiumLike {
  connectOverCDP(endpointUrl: string, options?: {
    timeout?: number;
    isLocal?: boolean;
    noDefaults?: boolean;
  }): Promise<PlaywrightBrowserLike>;
}

export function createPlaywrightCdpBackend(options: {
  chromium: PlaywrightChromiumLike;
  endpointForProfile(profile: BrowserProfileHandle): Promise<string>;
  connectTimeoutMs?: number;
}): BrowserBackend {
  return {
    kind: 'playwright-cdp',
    async open(profile) {
      const endpoint = await options.endpointForProfile(profile);
      const browser = await options.chromium.connectOverCDP(endpoint, {
        timeout: options.connectTimeoutMs ?? 30_000,
        isLocal: true,
        noDefaults: true,
      });
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      if (!context || !page) {
        await browser.close();
        throw new Error('Playwright CDP connection has no page');
      }
      const cdp = await context.newCDPSession(page);
      const session: BrowserBackendSession = {
        targetId: `playwright:${profile.profileId}`,
        async describe() {
          return { url: page.url(), title: await page.title() };
        },
        async exec(request: BrowserExecRequest) {
          return cdp.send(request.method, request.params);
        },
        async screenshot() {
          const data = await page.screenshot({ type: 'png' });
          return { mimeType: 'image/png' as const, dataBase64: Buffer.from(data).toString('base64') };
        },
        async close() {
          try {
            await cdp.detach();
          } finally {
            // This adapter is only for a WAG-owned dedicated browser. Browser.close() is intentionally
            // never used as an attach-to-someone-else cleanup primitive.
            await browser.close();
          }
        },
      };
      return session;
    },
  };
}
