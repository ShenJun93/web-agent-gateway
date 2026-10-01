export type ExistingBrowserTargetV1 = {
  tabId: number | null;
  windowId: number | null;
  title: string;
  url: string | null;
  origin: string | null;
  active: boolean;
  attachable: boolean;
  ownership: 'USER_EXISTING';
};

export class ExistingBrowserControlError extends Error {
  readonly code: string;
}

export function describeExistingBrowserTab(tab: unknown): ExistingBrowserTargetV1;

export function createExistingBrowserControlV1(
  chromeApi: {
    tabs: {
      query(queryInfo: Record<string, unknown>): Promise<unknown[]>;
      get(tabId: number): Promise<unknown>;
    };
    debugger: {
      attach(target: { tabId: number }, protocolVersion: string): Promise<void>;
      detach(target: { tabId: number }): Promise<void>;
      sendCommand(target: { tabId: number }, method: string, params?: unknown): Promise<any>;
      onDetach?: { addListener(listener: (source: { tabId?: number }) => void): void };
    };
  },
  options?: { protocolVersion?: string },
): {
  listTargets(): Promise<ExistingBrowserTargetV1[]>;
  attach(tabId: number): Promise<ExistingBrowserTargetV1 & { state: 'ATTACHED' }>;
  describe(tabId: number): Promise<ExistingBrowserTargetV1 & { attached: boolean }>;
  probe(tabId: number): Promise<{
    tabId: number;
    attached: true;
    origin: string | null;
    url: string | null;
  }>;
  exec(tabId: number, method: string, params?: Record<string, unknown>): Promise<any>;
  screenshot(tabId: number): Promise<{ mimeType: 'image/png'; dataBase64: string }>;
  release(tabId: number): Promise<{ tabId: number; released: boolean }>;
  isAttached(tabId: number): boolean;
};
