export interface BrowserControlWebSocketConfig {
  endpoint: string;
  pairingToken: string;
}

export interface BrowserControlWebSocketV1 {
  configure(config: BrowserControlWebSocketConfig): Promise<BrowserControlWebSocketConfig>;
  start(): Promise<void>;
  stop(): void;
  isConnected(): boolean;
  loadConfig(): Promise<BrowserControlWebSocketConfig | null>;
}

export function createBrowserControlWebSocketV1(options: {
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(value: Record<string, unknown>): Promise<void>;
  };
  control: any;
  WebSocketImpl?: typeof WebSocket;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): BrowserControlWebSocketV1;
