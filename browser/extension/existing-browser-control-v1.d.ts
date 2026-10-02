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
      query(queryInfo: Record<string, unknown>): Promise<any[]>;
      get(tabId: number): Promise<any>;
      create?(options: { url: string; active: boolean }): Promise<any>;
      remove?(tabId: number): Promise<void>;
      group?(options: { tabIds: number[] }): Promise<number>;
      onCreated?: { addListener(listener: (tab: any) => void): void };
      onUpdated?: { addListener(listener: (tabId: number, changeInfo: any, tab: any) => void): void };
    };
    tabGroups?: {
      update(groupId: number, options: Record<string, unknown>): Promise<any>;
    };
    debugger: {
      attach(target: { tabId: number }, protocolVersion: string): Promise<void>;
      detach(target: { tabId: number }): Promise<void>;
      sendCommand(target: { tabId: number }, method: string, params?: unknown): Promise<any>;
      onDetach?: { addListener(listener: (source: { tabId?: number }) => void): void };
      onEvent?: { addListener(listener: (source: { tabId?: number }, method: string, params: any) => void): void };
    };
  },
  options?: { protocolVersion?: string },
): {
  listTargets(): Promise<ExistingBrowserTargetV1[]>;
  create(): Promise<ExistingBrowserTargetV1>;
  watchContinuity(tabId: number): Promise<{ tabId: number; baselineSequence: number }>;
  resolveContinuity(rootTabId: number, currentTabId: number): Promise<{
    sequence: number;
    reason: 'CURRENT_GONE' | 'ROOT_UPDATED' | 'SUCCESSOR' | 'NO_CHANGE';
    target: ExistingBrowserTargetV1 | null;
  }>;
  group(tabId: number, title?: string): Promise<{ tabId: number; groupId: number; groupTitle: string; activeStable: boolean }>;
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
  close(tabId: number): Promise<{ tabId: number; closed: boolean }>;
  onControlEvent(listener: (event: {
    tabId: number;
    method: 'Browser.downloadWillBegin' | 'Browser.downloadProgress' | 'Page.javascriptDialogOpening' | 'Page.javascriptDialogClosed';
    params: Record<string, unknown>;
  }) => void): () => boolean;
  isAttached(tabId: number): boolean;
};
