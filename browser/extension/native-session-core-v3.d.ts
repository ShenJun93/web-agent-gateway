export interface NativePortLike {
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
  disconnect?(): void;
}
export interface NativeVerifySessionController {
  ensureReady(sessionId: string): Promise<void>;
  postTool(request: { version: 3; sessionId: string; [key: string]: unknown }): void;
  isConnected(): boolean;
}
export function createNativeVerifySessionController(options: {
  connectNative(): NativePortLike;
  randomUUID(): string;
  onToolResponse(response: unknown): void;
}): NativeVerifySessionController;
