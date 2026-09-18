export type V2BrowserAdapterRequest =
  | {
      version: 2;
      type: 'tool.call';
      requestId: string;
      sessionId: string;
      tool: 'health';
      arguments: Record<string, never>;
    }
  | {
      version: 2;
      type: 'tool.call';
      requestId: string;
      sessionId: string;
      tool: 'workspace.open';
      arguments: { path: string };
    }
  | {
      version: 2;
      type: 'tool.call';
      requestId: string;
      sessionId: string;
      tool: 'repo.search';
      arguments: {
        workspace_id: string;
        query: string;
        ignore_case?: boolean;
        max_results?: number;
        context_lines?: number;
      };
    }
  | {
      version: 2;
      type: 'tool.call';
      requestId: string;
      sessionId: string;
      tool: 'repo.snapshot';
      arguments: {
        workspace_id: string;
        max_files?: number;
      };
    }
  | {
      version: 2;
      type: 'tool.call';
      requestId: string;
      sessionId: string;
      tool: 'file.read';
      arguments: { workspace_id: string; path: string };
    };

export type BrowserAdapterRequest = V2BrowserAdapterRequest;

export type V2BrowserAdapterResponse =
  | { version: 2; type: 'result'; requestId: string; result: unknown }
  | { version: 2; type: 'error'; requestId: string; error: { code: string; message: string } };

export type BrowserAdapterResponse = V2BrowserAdapterResponse;

export interface ProviderSender {
  url?: string;
  tabId?: number;
}

export interface PendingBrowserRequest {
  requestId: string;
  tabId: number;
  request: V2BrowserAdapterRequest;
}

export interface DeliveredBrowserResponse {
  tabId: number;
  requestId: string;
  response: V2BrowserAdapterResponse;
}

export interface BrowserExtensionCore {
  queueProviderRequest(sender: ProviderSender, request: V2BrowserAdapterRequest): boolean;
  pending(): PendingBrowserRequest[];
  peekForExecution(requestId: string, actor: string): V2BrowserAdapterRequest | undefined;
  takeForExecution(requestId: string, actor: string): V2BrowserAdapterRequest | undefined;
  acceptNativeResponse(response: V2BrowserAdapterResponse): DeliveredBrowserResponse | undefined;
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
