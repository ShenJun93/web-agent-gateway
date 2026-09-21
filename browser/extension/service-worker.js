import {
  createBrowserOperatorExtensionCore,
  createSessionCorrelationStore,
  senderActor,
} from './service-worker-core-v4.js';
import { parseChatGptOperatorObservation } from './chatgpt-call-parser-v4.js';
import { createNativeOperatorSessionController } from './native-session-core-v4.js';
import { createNativeDelegationSessionController } from './native-session-core-v5.js';
import { stageAndDispatch } from './delegated-dispatch-core-v5.js';

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

/**
 * The delegated-dispatch port (ADR-0029), on its own native host.
 *
 * A second host, not a second mode on the first: the two admit into different adapter identities
 * and a delegation binds one of them. Connecting is lazy — `tryDelegatedRun` below is the only
 * caller, and it gives up quietly if the host is not installed, which is the state on every
 * machine that has not opted in.
 */
const delegation = createNativeDelegationSessionController({
  connectNative: () => chrome.runtime.connectNative('com.openai.web_agent_gateway_v5'),
  randomUUID: () => crypto.randomUUID(),
});

/**
 * Try to run one observed candidate under a delegation, before offering it to a human.
 *
 * Returns the outcome when WAG ran it, and `undefined` whenever it did not — no host, no
 * delegation offered, no workspace to bind to, or a refusal. **Every one of those falls through to
 * the human queue**, which is the direction that has to be true: `human-presence-boundary.md` says
 * Run stays human wherever a delegation does not admit the proposal, so the failure mode of this
 * whole function is "a person is asked", never "it happened anyway".
 *
 * Nothing here decides anything. It names a delegation id WAG handed it at bind time and asks. WAG
 * re-reads the row, the window, the budget and every binding, and answers.
 */
async function tryDelegatedRun({ correlationId, call, origin }) {
  // The delegation binds one workspace, and a staged candidate must name the same one in its
  // arguments. A tool that resolves no workspace (`health`) cannot be matched against the binding
  // here, so it is left for a person rather than guessed at.
  const workspaceId = call.arguments && call.arguments.workspace_id;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return undefined;

  try {
    await delegation.ensureReady(correlationId);
  } catch {
    // No v5 native host installed, or the handshake failed. Not an error worth surfacing: it is
    // the ordinary state of a machine that has not enabled delegated Run.
    return undefined;
  }

  const delegationId = delegation.delegationId();
  // WAG offered none, so none is configured and every proposal waits for a person.
  if (delegationId === undefined) return undefined;

  try {
    return await stageAndDispatch(delegation.send, {
      requestId: `req_${crypto.randomUUID()}`,
      // Distinct by construction. Equal ids would let a stage answer be read as a dispatch answer,
      // and the core refuses that outright — but not generating them equal is cheaper than relying
      // on being refused.
      dispatchRequestId: `dsp_${crypto.randomUUID()}`,
      sessionId: delegation.boundSessionId(),
      delegationId,
      tool: call.tool,
      workspaceId,
      origin,
      arguments: call.arguments,
    });
  } catch {
    return undefined;
  }
}

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
    void sessionCorrelations.forTab(tabId).then(async (sessionId) => {
      // Offered to a delegation first, and to a person otherwise. The order matters only because
      // doing it the other way would queue a proposal that then ran without the human ever seeing
      // it — two records of one candidate, one of them misleading.
      const delegated = await tryDelegatedRun({
        correlationId: sessionId,
        call,
        origin: new URL(senderUrl).origin,
      });
      if (delegated && delegated.ok && delegated.dispatched) {
        chrome.runtime.sendMessage({
          type: 'panel.delegated',
          proposalId: delegated.proposalId,
          result: delegated.result,
        }).catch(() => undefined);
        sendResponse({ queued: false, delegated: true, proposalId: delegated.proposalId });
        return;
      }

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
      sendResponse({
        queued,
        requestId: queued ? request.requestId : undefined,
        // Surfaced so a refused delegation is visible rather than looking like nothing happened.
        // It is a reason code, not a decision, and the panel treats it as text.
        ...(delegated && !delegated.ok ? { delegationRefusal: delegated.code } : {}),
      });
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
