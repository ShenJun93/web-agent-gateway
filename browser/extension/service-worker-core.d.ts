import type { BrowserAdapterRequest, BrowserAdapterResponse } from '../../src/browser-adapter/protocol.js';

export interface ProviderSender {
  url?: string;
  tabId?: number;
}

export interface PendingBrowserRequest {
  requestId: string;
  tabId: number;
  request: BrowserAdapterRequest;
}

export interface DeliveredBrowserResponse {
  tabId: number;
  requestId: string;
  response: BrowserAdapterResponse;
}

export interface BrowserExtensionCore {
  queueProviderRequest(sender: ProviderSender, request: BrowserAdapterRequest): boolean;
  pending(): PendingBrowserRequest[];
  takeForExecution(requestId: string, actor: string): BrowserAdapterRequest | undefined;
  acceptNativeResponse(response: BrowserAdapterResponse): DeliveredBrowserResponse | undefined;
  dismiss(requestId: string, actor: string): boolean;
}

export function createBrowserExtensionCore(): BrowserExtensionCore;
