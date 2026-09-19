export type V3BrowserVerifyRequest = {
  version: 3;
  type: 'tool.call';
  requestId: string;
  sessionId: string;
  tool: 'health' | 'workspace.open' | 'repo.search' | 'repo.snapshot' | 'file.read' | 'verify.preview' | 'verify.result';
  arguments: Record<string, unknown>;
};
export type V3BrowserVerifyResponse =
  | { version: 3; type: 'result'; requestId: string; result: unknown }
  | { version: 3; type: 'error'; requestId: string; error: { code: string; message: string } };
export interface ProviderSender { url?: string; tabId?: number; }
export interface BrowserVerifyExtensionCore {
  queueProviderRequest(sender: ProviderSender, request: V3BrowserVerifyRequest): boolean;
  pending(): Array<{ requestId: string; tabId: number; request: V3BrowserVerifyRequest }>;
  peekForExecution(requestId: string, actor: string): V3BrowserVerifyRequest | undefined;
  takeForExecution(requestId: string, actor: string): V3BrowserVerifyRequest | undefined;
  acceptNativeResponse(response: V3BrowserVerifyResponse): { tabId: number; requestId: string; response: V3BrowserVerifyResponse } | undefined;
  dismiss(requestId: string, actor: string): boolean;
}
export function createBrowserVerifyExtensionCore(): BrowserVerifyExtensionCore;
export interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, string>): Promise<void>;
  remove(key: string): Promise<void>;
}
export function createSessionCorrelationStore(storageSession: SessionStorageArea, randomUUID: () => string): {
  forTab(tabId: number): Promise<string>;
  removeTab(tabId: number): Promise<void>;
};
