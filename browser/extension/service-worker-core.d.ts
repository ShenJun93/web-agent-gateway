export type V1BrowserAdapterRequest =
  | {
      version: 1;
      type: 'tool.call';
      requestId: string;
      sessionId: string;
      tool: 'health';
      arguments: Record<string, never>;
    }
  | {
      version: 1;
      type: 'tool.call';
      requestId: string;
      sessionId: string;
      tool: 'workspace.open';
      arguments: { path: string };
    }
  | {
      version: 1;
      type: 'tool.call';
      requestId: string;
      sessionId: string;
      tool: 'file.read';
      arguments: { workspace_id: string; path: string };
    };

export type V1BrowserAdapterResponse =
  | { version: 1; type: 'result'; requestId: string; result: unknown }
  | { version: 1; type: 'error'; requestId: string; error: { code: string; message: string } };
export interface ProviderSender {
  url?: string;
  tabId?: number;
}

export interface PendingBrowserRequest {
  requestId: string;
  tabId: number;
  request: V1BrowserAdapterRequest;
}

export interface DeliveredBrowserResponse {
  tabId: number;
  requestId: string;
  response: V1BrowserAdapterResponse;
}

export interface BrowserExtensionCore {
  queueProviderRequest(sender: ProviderSender, request: V1BrowserAdapterRequest): boolean;
  pending(): PendingBrowserRequest[];
  takeForExecution(requestId: string, actor: string): V1BrowserAdapterRequest | undefined;
  acceptNativeResponse(response: V1BrowserAdapterResponse): DeliveredBrowserResponse | undefined;
  dismiss(requestId: string, actor: string): boolean;
}

export function createBrowserExtensionCore(): BrowserExtensionCore;
export interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, string>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SessionCorrelationStore {
  forTab(tabId: number): Promise<string>;
  removeTab(tabId: number): Promise<void>;
}

export function createSessionCorrelationStore(
  storageSession: SessionStorageArea,
  randomUUID: () => string,
): SessionCorrelationStore;
