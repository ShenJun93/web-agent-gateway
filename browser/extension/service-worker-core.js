const CHATGPT_ORIGIN = 'https://chatgpt.com';
const BROWSER_TOOLS = new Set(['health', 'workspace.open', 'file.read']);

export function createBrowserExtensionCore() {
  const queued = new Map();
  const inflight = new Map();

  function queueProviderRequest(sender, request) {
    if (!trustedSender(sender) || !validReadOnlyRequest(request)) return false;
    if (queued.has(request.requestId) || inflight.has(request.requestId)) return false;
    queued.set(request.requestId, { tabId: sender.tabId, request });
    return true;
  }

  function pending() {
    return [...queued.values()].map(({ tabId, request }) => ({ requestId: request.requestId, tabId, request }));
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
    if (!item) return undefined;
    inflight.delete(response.requestId);
    return { tabId: item.tabId, requestId: response.requestId, response };
  }

  function dismiss(requestId, actor) {
    if (actor !== 'sidepanel') return false;
    return queued.delete(requestId);
  }

  return { queueProviderRequest, pending, takeForExecution, acceptNativeResponse, dismiss };
}

function trustedSender(sender) {
  if (!Number.isInteger(sender?.tabId) || sender.tabId < 0 || typeof sender?.url !== 'string') return false;
  try { return new URL(sender.url).origin === CHATGPT_ORIGIN; }
  catch { return false; }
}

function validReadOnlyRequest(request) {
  return request && request.version === 1 && request.type === 'tool.call'
    && typeof request.requestId === 'string' && typeof request.sessionId === 'string'
    && BROWSER_TOOLS.has(request.tool) && request.arguments && typeof request.arguments === 'object';
}
