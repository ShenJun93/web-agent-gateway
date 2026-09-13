import { createBrowserExtensionCore } from './service-worker-core.js';

const core = createBrowserExtensionCore();
let nativePort;
let nativeBoundSession;
let helloSent = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'panel.state') {
    sendResponse({ pending: core.pending(), nativeConnected: Boolean(nativePort) });
    return false;
  }
  if (message?.type === 'panel.dismiss') {
    sendResponse({ dismissed: core.dismiss(message.requestId, 'sidepanel') });
    return false;
  }
  if (message?.type === 'panel.execute') {
    const request = core.takeForExecution(message.requestId, 'sidepanel');
    if (!request) { sendResponse({ accepted: false }); return false; }
    try {
      ensureNativeSession(request.sessionId);
      nativePort.postMessage(request);
      sendResponse({ accepted: true });
    } catch {
      sendResponse({ accepted: false });
    }
    return false;
  }
  return false;
});
function ensureNativeSession(sessionId) {
  if (!nativePort) {
    nativePort = chrome.runtime.connectNative('com.openai.web_agent_gateway');
    nativePort.onMessage.addListener(onNativeMessage);
    nativePort.onDisconnect.addListener(() => {
      nativePort = undefined;
      nativeBoundSession = undefined;
      helloSent = false;
    });
  }
  if (!helloSent) {
    nativePort.postMessage({ version: 1, type: 'hello', requestId: controlId('hello') });
    helloSent = true;
  }
  if (nativeBoundSession && nativeBoundSession !== sessionId) {
    nativePort.postMessage({ version: 1, type: 'session.unbind', requestId: controlId('unbind'), sessionId: nativeBoundSession });
    nativeBoundSession = undefined;
  }
  if (!nativeBoundSession) {
    nativePort.postMessage({
      version: 1, type: 'session.bind', requestId: controlId('bind'), sessionId,
      provider: 'chatgpt', origin: 'https://chatgpt.com',
    });
    nativeBoundSession = sessionId;
  }
}

function onNativeMessage(response) {
  const delivered = core.acceptNativeResponse(response);
  if (delivered) chrome.runtime.sendMessage({ type: 'panel.result', ...delivered }).catch(() => undefined);
}

function controlId(kind) {
  return `ctl_${kind}_${crypto.randomUUID()}`;
}
