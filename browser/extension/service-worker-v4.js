import {
  createBrowserOperatorExtensionCore,
  createSessionCorrelationStore,
  senderActor,
} from './service-worker-core-v4.js';
import { parseChatGptOperatorObservation } from './chatgpt-call-parser-v4.js';
import { createNativeOperatorSessionController } from './native-session-core-v4.js';

/**
 * The operator entry point (ADR-0026).
 *
 * A parallel entry to `service-worker.js` rather than a flag on it: the two speak different
 * protocol versions to different adapter identities, and the accepted v3 entry is frozen.
 *
 * Nothing here holds authority. A page-originated call becomes a queued *proposal*; the side
 * panel forwards it to the native host; and everything consequential the proposal asks for is
 * decided by the local operator on a channel this worker cannot see.
 */
const core = createBrowserOperatorExtensionCore();
const sessionCorrelations = createSessionCorrelationStore(chrome.storage.session, () => crypto.randomUUID());
const native = createNativeOperatorSessionController({
  connectNative: () => chrome.runtime.connectNative('com.openai.web_agent_gateway'),
  randomUUID: () => crypto.randomUUID(),
  onToolResponse: (response) => {
    const delivered = core.acceptNativeResponse(response);
    if (delivered) chrome.runtime.sendMessage({ type: 'panel.result', ...delivered }).catch(() => undefined);
  },
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // The actor is derived from what Chrome put in `sender`, never from what the message claims.
  const actor = senderActor(sender, chrome.runtime);

  if (message?.type === 'provider.observed_text') {
    const tabId = sender.tab?.id;
    const senderUrl = sender.url;
    if (actor !== 'content-script' || !Number.isInteger(tabId)
      || typeof senderUrl !== 'string' || !isChatGptUrl(senderUrl)) {
      sendResponse({ queued: false });
      return false;
    }
    const call = parseChatGptOperatorObservation({ text: message.text, codeBlocks: message.codeBlocks });
    if (!call) { sendResponse({ queued: false }); return false; }
    void sessionCorrelations.forTab(tabId).then((sessionId) => {
      const request = {
        version: 4,
        type: 'tool.call',
        requestId: `req_${crypto.randomUUID()}`,
        sessionId,
        tool: call.tool,
        arguments: call.arguments,
      };
      const queued = core.queueProviderRequest({ url: senderUrl, tabId }, request);
      sendResponse({ queued, requestId: queued ? request.requestId : undefined });
    }).catch(() => sendResponse({ queued: false }));
    return true;
  }

  if (message?.type === 'panel.state') {
    if (actor !== 'sidepanel') { sendResponse({ pending: [], nativeConnected: false }); return false; }
    sendResponse({ pending: core.pending(), nativeConnected: native.isConnected() });
    return false;
  }

  if (message?.type === 'panel.dismiss') {
    sendResponse({ dismissed: core.dismiss(message.requestId, actor) });
    return false;
  }

  if (message?.type === 'panel.execute') {
    // Peek before the handshake and take after it, so a failed handshake leaves the proposal
    // queued rather than consuming it.
    const pending = core.peekForExecution(message.requestId, actor);
    if (!pending) {
      sendResponse({ accepted: false });
      return false;
    }
    void native.ensureReady(pending.sessionId).then(() => {
      const request = core.takeForExecution(message.requestId, actor);
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
