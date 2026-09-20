export interface NativePortLike {
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
  disconnect?(): void;
}
export interface NativeOperatorSessionController {
  ensureReady(sessionId: string): Promise<void>;
  postTool(request: { version: 4; sessionId: string; [key: string]: unknown }): void;
  isConnected(): boolean;
}
export function createNativeOperatorSessionController(options: {
  connectNative(): NativePortLike;
  randomUUID(): string;
  onToolResponse(response: unknown): void;
}): NativeOperatorSessionController;
