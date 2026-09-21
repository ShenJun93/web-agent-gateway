import {
  createBrowserOperatorExtensionCore,
  createSessionCorrelationStore,
  senderActor,
} from './service-worker-core-v4.js';
import { parseChatGptOperatorObservation } from './chatgpt-call-parser-v4.js';
import { createNativeOperatorSessionController } from './native-session-core-v4.js';

/**
 * The shipped entry point, now the operator adapter (ADR-0026).
 *
 * The v3 modules are frozen and still present: this file chooses which generation the product
 * ships, and the cutover is the whole point of the change. A v3 build is still exactly the v3
 * modules, and `test/browser-extension-v3.test.ts` still holds them to their contract.
 *
 * Nothing here holds authority. A page-originated call becomes a queued *proposal*; the side
 * panel forwards it to the native host; and everything consequential the proposal asks for is
 * decided by the local operator on a channel this worker cannot see.
 */
const core = createBrowserOperatorExtensionCore(chrome.storage.session, {
  // Tell an already-open side panel that the pending list changed. The panel refreshes on load
  // and after an action, and its document survives being hidden and shown — so before this, a
  // proposal queued while the panel was open stayed invisible until the panel was closed
  // outright. The message carries a count and nothing else: the panel asks for the real state.
  onQueued: (pending) => {
    chrome.runtime.sendMessage({ type: 'panel.pending', pending }).catch(() => undefined);
  },
});
const sessionCorrelations = createSessionCorrelationStore(chrome.storage.session, () => crypto.randomUUID());
// A suspended worker must not silently lose a proposal a human has not looked at yet.
const restored = core.restore().catch(() => undefined);
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
      // The provider's own message id is what makes a rescan idempotent; it is carried, never
      // trusted as authority.
      const queued = core.queueProviderRequest({ url: senderUrl, tabId }, request, message.messageId);
      sendResponse({ queued, requestId: queued ? request.requestId : undefined });
    }).catch(() => sendResponse({ queued: false }));
    return true;
  }

  if (message?.type === 'panel.state') {
    if (actor !== 'sidepanel') { sendResponse({ pending: [], nativeConnected: false }); return false; }
    // The panel is usually the first thing to touch a restarted worker, so wait for the
    // restore before answering rather than reporting an empty queue that is merely not loaded.
    void restored
      // Opening the panel is what re-attaches the bridge and asks for a rescan, so a user who
      // reloaded the extension does not have to reload the conversation by hand. The rescan is
      // idempotent, so doing it on every panel open costs nothing.
      .then(() => attachAndRescan())
      .then(() => sendResponse({ pending: core.pending(), nativeConnected: native.isConnected() }))
      .catch(() => sendResponse({ pending: core.pending(), nativeConnected: native.isConnected() }));
    return true;
  }

  if (message?.type === 'panel.dismiss') {
    sendResponse({ dismissed: core.dismiss(message.requestId, actor) });
    return false;
  }

  if (message?.type === 'panel.execute') {
    // Peek before the handshake and take after it, so a failed handshake leaves the proposal
    // queued rather than consuming it.
    void restored.then(async () => {
      const pending = core.peekForExecution(message.requestId, actor);
      if (!pending) {
        sendResponse({ accepted: false });
        return;
      }
      await native.ensureReady(pending.sessionId);
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

// An extension reload or a worker restart orphans the content script in tabs that are already
// open, and the user should not have to reload the conversation to get it back.
for (const event of [chrome.runtime.onInstalled, chrome.runtime.onStartup]) {
  event.addListener(() => { void attachAndRescan(); });
}

/**
 * Re-inject the bridge into every already-open allowed tab, then ask each for a rescan.
 *
 * Injection is scoped by the same host permission the manifest declares, so this reaches no
 * page the content script would not already run on. Nothing here is consequential: a rescan
 * can only re-offer proposals, and moving one still needs the side panel.
 */
async function attachAndRescan() {
  let tabs;
  try { tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }); }
  catch { return; }
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ['content/chatgpt.js'],
      });
    } catch {
      // Already injected, or the tab went away. Either way the rescan below is still worth trying.
    }
    try { await chrome.tabs.sendMessage(tab.id, { type: 'provider.rescan' }); }
    catch { /* no receiver in this tab */ }
  }
}

function isChatGptUrl(value) {
  try { return new URL(value).origin === 'https://chatgpt.com'; }
  catch { return false; }
}
