export type V4BrowserOperatorRequest = {
  version: 4;
  type: 'tool.call';
  requestId: string;
  sessionId: string;
  tool:
    | 'health' | 'workspace.open' | 'repo.search' | 'repo.snapshot' | 'file.read'
    | 'verify.preview' | 'verify.result'
    | 'mutation.preview' | 'file.create' | 'mutation.result'
    | 'git.commit' | 'git.commit.result';
  arguments: Record<string, unknown>;
};
export type V4BrowserOperatorResponse =
  | { version: 4; type: 'result'; requestId: string; result: unknown }
  | { version: 4; type: 'error'; requestId: string; error: { code: string; message: string } };
export interface ProviderSender { url?: string; tabId?: number; }
export interface BrowserOperatorExtensionCore {
  queueProviderRequest(
    sender: ProviderSender,
    request: V4BrowserOperatorRequest,
    messageId: string | undefined,
  ): boolean;
  pending(): Array<{ requestId: string; tabId: number; request: V4BrowserOperatorRequest }>;
  peekForExecution(requestId: string, actor: string): V4BrowserOperatorRequest | undefined;
  takeForExecution(requestId: string, actor: string): V4BrowserOperatorRequest | undefined;
  acceptNativeResponse(response: V4BrowserOperatorResponse): { tabId: number; requestId: string; response: V4BrowserOperatorResponse } | undefined;
  dismiss(requestId: string, actor: string): boolean;
  /** Reload proposals a suspended worker left behind; safe to call more than once. */
  restore(): Promise<void>;
}
/** The stable identity of a proposal: WAG session, tab, provider message id, tool, arguments. */
export function proposalIdentity(
  sessionId: string,
  tabId: number,
  messageId: string,
  tool: string,
  args: unknown,
): string;
export function createBrowserOperatorExtensionCore(
  storageSession?: SessionStorageArea,
): BrowserOperatorExtensionCore;
export interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
export function createSessionCorrelationStore(storageSession: SessionStorageArea, randomUUID: () => string): {
  forTab(tabId: number): Promise<string>;
  removeTab(tabId: number): Promise<void>;
};
export interface RuntimeSender { id?: string; url?: string; tab?: unknown; frameId?: number; }
export interface RuntimeIdentity { id?: string; getURL(path: string): string; }
export function senderActor(sender: RuntimeSender | undefined, runtime: RuntimeIdentity): 'sidepanel' | 'content-script' | undefined;
