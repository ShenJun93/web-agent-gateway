export interface NativeBrowserControlPort {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: any) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface NativeBrowserControlV1 {
  ensureConnected(): NativeBrowserControlPort;
  handle(message: unknown): Promise<unknown>;
  isConnected(): boolean;
}

export function createNativeBrowserControlV1(options: {
  connectNative(): NativeBrowserControlPort;
  extensionReleaseIdentity?: { schema?: string; sourceHead?: string };
  reloadExtension?: () => void;
  setTimeoutImpl?: (callback: () => void, delay?: number) => unknown;
  control: {
    listTargets(): Promise<any[]>;
    create(): Promise<any>;
    watchContinuity(tabId: number): Promise<{ tabId: number; baselineSequence: number }>;
    resolveContinuity(rootTabId: number, currentTabId: number): Promise<{ sequence: number; reason: string; target: any | null }>;
    group(tabId: number, title?: string): Promise<{ tabId: number; groupId: number; groupTitle: string; activeStable: boolean }>;
    attach(tabId: number): Promise<any>;
    describe(tabId: number): Promise<any>;
    exec(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
    screenshot(tabId: number): Promise<{ mimeType: 'image/png'; dataBase64: string }>;
    release(tabId: number): Promise<{ tabId: number; released: boolean }>;
    close(tabId: number): Promise<{ tabId: number; closed: boolean }>;
    onDownloadEvent?(listener: (event: { tabId: number; method: 'Browser.downloadWillBegin' | 'Browser.downloadProgress'; params: Record<string, unknown> }) => void): () => unknown;
    isAttached(tabId: number): boolean;
  };
}): NativeBrowserControlV1;
