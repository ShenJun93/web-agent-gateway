import type { V2BrowserAdapterRequest, V2BrowserAdapterResponse } from './service-worker-core.js';

export interface NativePort {
  postMessage(message: unknown): void;
  disconnect?(): void;
  onMessage: {
    addListener(listener: (message: any) => void): void;
    removeListener?(listener: (message: any) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener?(listener: () => void): void;
  };
}

export interface NativeSessionControllerOptions {
  connectNative: () => NativePort;
  randomUUID: () => string;
  onToolResponse: (response: V2BrowserAdapterResponse) => void;
}

export interface NativeSessionController {
  ensureReady(sessionId: string): Promise<void>;
  postTool(request: V2BrowserAdapterRequest): void;
  isConnected(): boolean;
}

export function createNativeSessionController(options: NativeSessionControllerOptions): NativeSessionController;
