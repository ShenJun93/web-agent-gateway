const CHATGPT_ORIGIN = 'https://chatgpt.com';
// The operator surface (ADR-0026): the accepted seven, plus five proposals. Every one of
// these either reads or creates a record a local human must approve. Filtering here is
// defence in depth; WAG enforces the profile server-side.
const BROWSER_OPERATOR_TOOLS = new Set([
  'health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read',
  'verify.preview', 'verify.result',
  'mutation.preview', 'file.create', 'mutation.result',
  'git.commit', 'git.commit.result',
]);

export function createBrowserOperatorExtensionCore() {
  const queued = new Map();
  const inflight = new Map();

  function queueProviderRequest(sender, request) {
    if (!trustedSender(sender) || !validV4Request(request)) return false;
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
    if (!item || response?.version !== 4) return undefined;
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

function validV4Request(request) {
  return request && request.version === 4 && request.type === 'tool.call'
    && typeof request.requestId === 'string' && typeof request.sessionId === 'string'
    && BROWSER_OPERATOR_TOOLS.has(request.tool) && request.arguments && typeof request.arguments === 'object';
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

/**
 * Which actor a runtime message came from.
 *
 * The side panel is the only thing that may move a queued proposal, so "sidepanel" cannot be a
 * literal the glue passes in: a content script can reach the same `chrome.runtime.onMessage`
 * listener, and a hard-coded actor would hand it the side panel's authority. Chrome fills in
 * `sender` itself and a page cannot forge it, so the actor is derived from three of its facts:
 * the message came from this extension, it did not come from a tab, and its URL is the side
 * panel document.
 *
 * `runtime.id` and `runtime.getURL` are passed rather than read, so this stays testable and
 * stays honest about what it depends on.
 */
export function senderActor(sender, runtime) {
  if (!sender || typeof sender !== 'object') return undefined;
  if (typeof runtime?.id !== 'string' || sender.id !== runtime.id) return undefined;
  // Anything hosted in a tab is page-adjacent, whatever its URL claims.
  if (sender.tab !== undefined) return 'content-script';
  if (typeof sender.frameId === 'number' && sender.frameId !== 0) return undefined;
  // `sender.url` carries a query or hash in some Chrome builds, so compare the document, not the
  // whole string. Both sides go through the same stripping, and a chrome-extension URL is not
  // parsed: its scheme is not special, so URL() reports its origin as "null" and would make two
  // different extensions' documents compare equal.
  const document = stripFragmentAndQuery(runtime.getURL('sidepanel.html'));
  return document !== '' && stripFragmentAndQuery(sender.url) === document ? 'sidepanel' : undefined;
}

function stripFragmentAndQuery(value) {
  if (typeof value !== 'string') return '';
  return value.split('#', 1)[0].split('?', 1)[0];
}
