const BROWSER_INSPECT_ADAPTER_ID = 'browser.chatgpt.native.inspect.v2';
const BROWSER_ADAPTER_PROTOCOL_VERSION = 2;
const EXPECTED_TOOLS = Object.freeze([
  'health',
  'workspace.open',
  'repo.search',
  'repo.snapshot',
  'file.read',
]);

export function createNativeSessionController({ connectNative, randomUUID, onToolResponse }) {
  let port = null;
  let helloVerified = false;
  let boundSession = null;
  const pendingControl = new Map();
  let handshakeInProgress = null;

  function handleMessage(message) {
    const requestId = message?.requestId;
    if (typeof requestId === 'string' && pendingControl.has(requestId)) {
      const { resolve, reject } = pendingControl.get(requestId);
      pendingControl.delete(requestId);
      if (message.version !== BROWSER_ADAPTER_PROTOCOL_VERSION) {
        reject(new Error(`Invalid protocol version: expected ${BROWSER_ADAPTER_PROTOCOL_VERSION}`));
      } else if (message.type === 'error') {
        reject(new Error(message.error?.message || 'Control request failed'));
      } else if (message.type === 'result') {
        resolve(message.result);
      } else {
        reject(new Error('Invalid control response'));
      }
      return;
    }
    onToolResponse(message);
  }

  function handleDisconnect() {
    port = null;
    helloVerified = false;
    boundSession = null;
    const errors = [...pendingControl.values()];
    pendingControl.clear();
    for (const { reject } of errors) {
      reject(new Error('Native messaging host disconnected'));
    }
  }

  function sendControl(type, payload) {
    return new Promise((resolve, reject) => {
      if (!port) {
        reject(new Error('Native port not connected'));
        return;
      }
      const kind = type.replace('session.', '').replace('.list', '');
      const requestId = `ctl_${kind}_${randomUUID()}`;
      pendingControl.set(requestId, { resolve, reject });
      try {
        port.postMessage({
          version: BROWSER_ADAPTER_PROTOCOL_VERSION,
          type,
          requestId,
          ...payload,
        });
      } catch (err) {
        pendingControl.delete(requestId);
        reject(err);
      }
    });
  }

  async function ensureReady(sessionId) {
    if (port && helloVerified && boundSession === sessionId) {
      return;
    }

    if (!port) {
      port = connectNative();
      port.onMessage.addListener(handleMessage);
      port.onDisconnect.addListener(handleDisconnect);
      helloVerified = false;
      boundSession = null;
    }

    if (handshakeInProgress) {
      await handshakeInProgress;
      if (port && helloVerified && boundSession === sessionId) {
        return;
      }
    }

    const handshake = (async () => {
      if (!helloVerified) {
        const result = await sendControl('hello', {});
        if (
          result?.protocolVersion !== BROWSER_ADAPTER_PROTOCOL_VERSION ||
          result?.adapterId !== BROWSER_INSPECT_ADAPTER_ID
        ) {
          throw new Error('Native host hello protocol or adapterId mismatch');
        }
        helloVerified = true;
      }

      if (boundSession && boundSession !== sessionId) {
        await sendControl('session.unbind', { sessionId: boundSession });
        boundSession = null;
      }

      if (boundSession !== sessionId) {
        await sendControl('session.bind', {
          sessionId,
          provider: 'chatgpt',
          origin: 'https://chatgpt.com',
        });
        const listResult = await sendControl('tools.list', { sessionId });
        if (!validateTools(listResult?.tools)) {
          throw new Error('Native host tools profile mismatch');
        }
        boundSession = sessionId;
      }
    })();

    handshakeInProgress = handshake;
    try {
      await handshake;
    } catch (err) {
      if (port && typeof port.disconnect === 'function') port.disconnect();
      handleDisconnect();
      throw err;
    } finally {
      if (handshakeInProgress === handshake) {
        handshakeInProgress = null;
      }
    }
  }

  function postTool(request) {
    if (!port || !helloVerified || boundSession !== request?.sessionId) {
      throw new Error('Native session not ready');
    }
    port.postMessage(request);
  }

  function isConnected() {
    return Boolean(port && helloVerified && boundSession !== null);
  }

  return {
    ensureReady,
    postTool,
    isConnected,
  };
}

function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length !== EXPECTED_TOOLS.length) return false;
  return EXPECTED_TOOLS.every((tool, index) => tools[index] === tool);
}
