import { createBrowserExtensionCore, createSessionCorrelationStore } from './service-worker-core.js';
import { parseChatGptObservation } from './chatgpt-call-parser.js';
import { createNativeSessionController } from './native-session-core.js';

const core = createBrowserExtensionCore();
const sessionCorrelations = createSessionCorrelationStore(chrome.storage.session, () => crypto.randomUUID());
const native = createNativeSessionController({
  connectNative: () => chrome.runtime.connectNative('com.openai.web_agent_gateway'),
  randomUUID: () => crypto.randomUUID(),
  onToolResponse: (response) => {
    const delivered = core.acceptNativeResponse(response);
    if (delivered) chrome.runtime.sendMessage({ type: 'panel.result', ...delivered }).catch(() => undefined);
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'provider.observed_text') {
    const tabId = sender.tab?.id;
    const senderUrl = sender.url;
    if (!Number.isInteger(tabId) || typeof senderUrl !== 'string' || !isChatGptUrl(senderUrl)) {
      sendResponse({ queued: false });
      return false;
    }
    const call = parseChatGptObservation({ text: message.text, codeBlocks: message.codeBlocks });
    if (!call) { sendResponse({ queued: false }); return false; }
    void sessionCorrelations.forTab(tabId).then((sessionId) => {
      const request = {
        version: 2, type: 'tool.call', requestId: `req_${crypto.randomUUID()}`,
        sessionId, tool: call.tool, arguments: call.arguments,
      };
      const queued = core.queueProviderRequest({ url: senderUrl, tabId }, request);
      sendResponse({ queued, requestId: queued ? request.requestId : undefined });
    }).catch(() => sendResponse({ queued: false }));
    return true;
  }
  if (message?.type === 'panel.state') {
    sendResponse({ pending: core.pending(), nativeConnected: native.isConnected() });
    return false;
  }
  if (message?.type === 'panel.dismiss') {
    sendResponse({ dismissed: core.dismiss(message.requestId, 'sidepanel') });
    return false;
  }
  if (message?.type === 'panel.execute') {
    const pending = core.peekForExecution(message.requestId, 'sidepanel');
    if (!pending) {
      sendResponse({ accepted: false });
      return false;
    }
    void native.ensureReady(pending.sessionId).then(() => {
      const request = core.takeForExecution(message.requestId, 'sidepanel');
      if (!request) {
        sendResponse({ accepted: false });
        return;
      }
      native.postTool(request);
      sendResponse({ accepted: true });
    }).catch(() => {
      sendResponse({ accepted: false });
    });
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void sessionCorrelations.removeTab(tabId).catch(() => undefined);
});

function isChatGptUrl(value) {
  try { return new URL(value).origin === 'https://chatgpt.com'; }
  catch { return false; }
}
