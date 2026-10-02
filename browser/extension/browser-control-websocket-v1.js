import { createNativeBrowserControlV1 } from './native-browser-control-v1.js';

const CONFIG_KEY = 'wagBrowserControlWebSocketV1';
const LOOPBACK_ENDPOINT = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/browser-control$/;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

export function createBrowserControlWebSocketV1(options) {
  const storage = options.storage;
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const schedule = options.setTimeoutImpl ?? globalThis.setTimeout;
  const cancel = options.clearTimeoutImpl ?? globalThis.clearTimeout;
  const dispatcher = createNativeBrowserControlV1({
    connectNative: () => { throw new Error('Native transport is disabled for Browser v2 WebSocket control'); },
    control: options.control,
    extensionReleaseIdentity: options.extensionReleaseIdentity,
    reloadExtension: options.reloadExtension,
    setTimeoutImpl: schedule,
  });

  let socket;
  let reconnectTimer;
  let heartbeatTimer;
  let connected = false;
  let stopping = false;

  let unsubscribeDownloadEvents;

  function ensureDownloadEventSubscription() {
    if (unsubscribeDownloadEvents !== undefined || typeof options.control?.onDownloadEvent !== 'function') return;
    unsubscribeDownloadEvents = options.control.onDownloadEvent((event) => {
      const current = socket;
      if (!connected || !current || current.readyState !== WebSocketImpl.OPEN) return;
      current.send(JSON.stringify({
        version: 1,
        type: 'control.event',
        targetId: `tab_${event.tabId}`,
        method: event.method,
        params: event.params,
      }));
    });
  }

  async function configure(config) {
    const normalized = validateConfig(config);
    await storage.set({ [CONFIG_KEY]: normalized });
    stopping = false;
    disconnect();
    await start();
    return normalized;
  }

  async function loadConfig() {
    const row = await storage.get(CONFIG_KEY);
    const value = row?.[CONFIG_KEY];
    return value ? validateConfig(value) : null;
  }

  async function clearConfig() {
    stopping = true;
    disconnect();
    await storage.remove(CONFIG_KEY);
  }

  async function start() {
    if (stopping || socket) return;
    const config = await loadConfig();
    if (!config) return;
    ensureDownloadEventSubscription();
    connect(config);
  }

  function connect(config) {
    if (stopping || socket) return;
    let current;
    try {
      current = new WebSocketImpl(config.endpoint);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;

    current.addEventListener('open', () => {
      current.send(JSON.stringify({
        version: 1,
        type: 'control.hello',
        extensionRelease: {
          schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1',
          sourceHead: typeof options.extensionReleaseIdentity?.sourceHead === 'string'
            ? options.extensionReleaseIdentity.sourceHead
            : 'development',
        },
        pairingToken: config.pairingToken,
      }));
    });

    current.addEventListener('message', (event) => {
      void onMessage(current, event?.data);
    });

    current.addEventListener('close', () => {
      if (socket === current) socket = undefined;
      connected = false;
      stopHeartbeat();
      scheduleReconnect();
    });

    current.addEventListener('error', () => {
      // Close drives the bounded reconnect path.
    });
  }

  async function onMessage(current, raw) {
    if (typeof raw !== 'string') return;
    let message;
    try { message = JSON.parse(raw); } catch { return; }

    if (message?.version === 1 && message?.type === 'control.ready') {
      connected = true;
      startHeartbeat(current);
      return;
    }
    if (message?.version === 1 && message?.type === 'control.pong') return;
    if (message?.version !== 1 || message?.type !== 'control.request') return;

    let response;
    try {
      response = await dispatcher.handle(message);
    } catch (error) {
      response = {
        version: 1,
        type: 'control.error',
        requestId: typeof message.requestId === 'string' ? message.requestId : 'bctl_00000000-0000-4000-8000-000000000000',
        error: {
          code: String(error?.code ?? 'CONTROL_FAILED').slice(0, 128),
          message: String(error instanceof Error ? error.message : 'Browser control failed').slice(0, 512),
        },
      };
    }
    if (current.readyState === WebSocketImpl.OPEN) current.send(JSON.stringify(response));
  }

  function startHeartbeat(current) {
    stopHeartbeat();
    const tick = () => {
      if (current !== socket || current.readyState !== WebSocketImpl.OPEN) return;
      current.send(JSON.stringify({ version: 1, type: 'control.ping' }));
      heartbeatTimer = schedule(tick, 20_000);
    };
    heartbeatTimer = schedule(tick, 20_000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== undefined) cancel(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function scheduleReconnect() {
    if (stopping || reconnectTimer !== undefined) return;
    reconnectTimer = schedule(() => {
      reconnectTimer = undefined;
      void start();
    }, 2_000);
  }

  function disconnect() {
    connected = false;
    stopHeartbeat();
    if (reconnectTimer !== undefined) cancel(reconnectTimer);
    reconnectTimer = undefined;
    const current = socket;
    socket = undefined;
    try { current?.close(); } catch {}
  }

  function stop() {
    stopping = true;
    disconnect();
    try { unsubscribeDownloadEvents?.(); } catch {}
    unsubscribeDownloadEvents = undefined;
  }

  return {
    configure,
    clearConfig,
    start,
    stop,
    isConnected: () => connected,
    loadConfig,
  };
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser control WebSocket config is invalid');
  }
  const endpoint = value.endpoint;
  const pairingToken = value.pairingToken;
  const match = typeof endpoint === 'string' ? endpoint.match(LOOPBACK_ENDPOINT) : null;
  const port = match ? Number(match[1]) : NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Browser control endpoint must be loopback WebSocket');
  }
  if (typeof pairingToken !== 'string' || !TOKEN.test(pairingToken)) {
    throw new Error('Browser control pairing token is invalid');
  }
  return { endpoint, pairingToken };
}
