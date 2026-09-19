const CHATGPT_ORIGIN = 'https://chatgpt.com';
const BROWSER_VERIFY_TOOLS = new Set([
  'health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read',
  'verify.preview', 'verify.result',
]);

export function createBrowserVerifyExtensionCore() {
  const queued = new Map();
  const inflight = new Map();

  function queueProviderRequest(sender, request) {
    if (!trustedSender(sender) || !validV3Request(request)) return false;
    if (queued.has(request.requestId) || inflight.has(request.requestId)) return false;
    queued.set(request.requestId, { tabId: sender.tabId, request });
    return true;
  }

  function pending() {
    return [...queued.values()].map(({ tabId, request }) => ({ requestId: request.requestId, tabId, request }));
  }

  function peekForExecution(requestId, actor) {
    if (actor !== 'sidepanel') return undefined;
    return queued.get(requestId)?.request;
  }

  function takeForExecution(requestId, actor) {
    if (actor !== 'sidepanel') return undefined;
    const item = queued.get(requestId);
    if (!item) return undefined;
    queued.delete(requestId);
    inflight.set(requestId, item);
    return item.request;
  }

  function acceptNativeResponse(response) {
    const item = inflight.get(response?.requestId);
    if (!item || response?.version !== 3) return undefined;
    inflight.delete(response.requestId);
    return { tabId: item.tabId, requestId: response.requestId, response };
  }

  function dismiss(requestId, actor) {
    if (actor !== 'sidepanel') return false;
    return queued.delete(requestId);
  }

  return { queueProviderRequest, pending, peekForExecution, takeForExecution, acceptNativeResponse, dismiss };
}

function trustedSender(sender) {
  if (!Number.isInteger(sender?.tabId) || sender.tabId < 0 || typeof sender?.url !== 'string') return false;
  try { return new URL(sender.url).origin === CHATGPT_ORIGIN; }
  catch { return false; }
}

function validV3Request(request) {
  return request && request.version === 3 && request.type === 'tool.call'
    && typeof request.requestId === 'string' && typeof request.sessionId === 'string'
    && BROWSER_VERIFY_TOOLS.has(request.tool) && request.arguments && typeof request.arguments === 'object';
}

export function createSessionCorrelationStore(storageSession, randomUUID) {
  const keyForTab = (tabId) => {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid browser tab id');
    return `wag.session.tab.${tabId}`;
  };

  async function forTab(tabId) {
    const key = keyForTab(tabId);
    const existing = (await storageSession.get(key))?.[key];
    if (typeof existing === 'string' && /^session_[0-9a-f-]{36}$/i.test(existing)) return existing;
    const correlation = `session_${randomUUID()}`;
    if (!/^session_[0-9a-f-]{36}$/i.test(correlation)) throw new Error('Invalid browser correlation');
    await storageSession.set({ [key]: correlation });
    return correlation;
  }

  async function removeTab(tabId) {
    await storageSession.remove(keyForTab(tabId));
  }

  return { forTab, removeTab };
}
