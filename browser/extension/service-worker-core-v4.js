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

/** Outstanding proposals one browser session may hold, mirroring WAG's own live cap. */
const MAX_QUEUED_PROPOSALS = 8;
/** How many settled proposals stay remembered, so a rescan does not re-offer them. */
const MAX_REMEMBERED_PROPOSALS = 256;
// One prefix, so the two slots cannot drift apart and neither reads as a credential literal.
const STORAGE_PREFIX = 'wag.operator.';
const QUEUE_STORAGE_KEY = `${STORAGE_PREFIX}queue.v4`;
const SEEN_STORAGE_KEY = `${STORAGE_PREFIX}seen.v4`;

/**
 * The identity of a proposal, as opposed to the identity of one observation of it.
 *
 * A rescan, a page reload, a worker restart, an extension reload and a side-panel reopen all
 * re-observe the same assistant message, and each observation used to mint a fresh random
 * request id — which is why the live dogfood filled the panel with duplicates. The stable parts
 * are the WAG session, the tab, the provider's own message id, the tool, and the exact
 * arguments; anything with the same five is the same proposal.
 *
 * Two legitimately different messages proposing byte-identical payloads differ in `messageId`,
 * so they are correctly two proposals.
 */
export function proposalIdentity(sessionId, tabId, messageId, tool, args) {
  return [sessionId, String(tabId), messageId, tool, canonicalJson(args)].join('\u0000');
}

/** Key order must not change the identity, so object keys are sorted on the way in. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * @param storageSession `chrome.storage.session` when the worker builds it. Optional so unit
 *   tests can exercise the pure in-memory behaviour, but production always passes it.
 * @param hooks.onQueued Called with the new pending count when — and only when — a proposal is
 *   actually queued. The side panel refreshes on load and after an action, and its document
 *   survives being hidden and shown, so without this a panel that was already open never learned
 *   about a proposal queued afterwards: storage held it and the panel showed an empty list.
 *   A repeat observation of the same message is deliberately silent, because a rescan is
 *   idempotent and a panel that flickered on every rescan would be lying about what changed.
 */
export function createBrowserOperatorExtensionCore(storageSession, hooks = {}) {
  const queued = new Map();
  const inflight = new Map();
  // Proposal identities this browser session has already offered, in first-seen order. A
  // settled or dismissed proposal stays here so a later rescan does not raise it again.
  const remembered = new Set();

  // MV3 suspends an idle service worker after about thirty seconds, which discarded the whole
  // queue. Measured in the live dogfood: the proposal was accepted, the human opened the side
  // panel a minute later, and the panel was empty with nothing logged. A queued proposal has to
  // outlive the worker that accepted it, because a human is what moves it.
  //
  // `chrome.storage.session` is the right home: it survives a worker restart, it is memory
  // backed, it is cleared when the browser closes, and it is not durable authority — the
  // durable record only exists once WAG has admitted the call.
  function persist() {
    if (!storageSession) return;
    const snapshot = [...queued.values()].slice(-MAX_QUEUED_PROPOSALS);
    const seen = [...remembered].slice(-MAX_REMEMBERED_PROPOSALS);
    void Promise.resolve(storageSession.set({
      [QUEUE_STORAGE_KEY]: snapshot,
      [SEEN_STORAGE_KEY]: seen,
    })).catch(() => undefined);
  }

  let restored = false;
  async function restore() {
    if (!storageSession || restored) return;
    restored = true;
    let stored;
    try { stored = await storageSession.get(null); }
    catch { return; }

    const seen = stored?.[SEEN_STORAGE_KEY];
    if (Array.isArray(seen)) {
      for (const key of seen.slice(-MAX_REMEMBERED_PROPOSALS)) {
        if (typeof key === 'string' && key.length <= 4096) remembered.add(key);
      }
    }

    const items = stored?.[QUEUE_STORAGE_KEY];
    if (!Array.isArray(items)) return;
    // What comes back is re-validated: storage is not a trusted channel just because we wrote it.
    for (const item of items.slice(-MAX_QUEUED_PROPOSALS)) {
      if (!item || typeof item !== 'object') continue;
      if (!validV4Request(item.request) || !Number.isInteger(item.tabId)) continue;
      if (typeof item.identity !== 'string' || !item.identity) continue;
      if (queued.has(item.identity) || inflight.has(item.request.requestId)) continue;
      queued.set(item.identity, { tabId: item.tabId, request: item.request, identity: item.identity });
      remembered.add(item.identity);
    }
  }

  function queueProviderRequest(sender, request, messageId) {
    if (!trustedSender(sender) || !validV4Request(request)) return false;
    // A turn with no provider-assigned identity cannot be deduplicated, and an unstable
    // identity would be worse than refusing: it is exactly what produced the duplicates.
    if (typeof messageId !== 'string' || !messageId || messageId.length > 128) return false;

    const identity = proposalIdentity(request.sessionId, sender.tabId, messageId, request.tool, request.arguments);
    if (remembered.has(identity)) return false;
    if (queued.size >= MAX_QUEUED_PROPOSALS) return false;

    queued.set(identity, { tabId: sender.tabId, request, identity });
    remembered.add(identity);
    if (remembered.size > MAX_REMEMBERED_PROPOSALS) {
      remembered.delete(remembered.values().next().value);
    }
    persist();
    try { hooks.onQueued?.(queued.size); }
    catch { /* a panel that is not open, or has gone away, must not fail the queue */ }
    return true;
  }

  function pending() {
    return [...queued.values()].map(({ tabId, request }) => ({ requestId: request.requestId, tabId, request }));
  }

  function findQueued(requestId) {
    for (const item of queued.values()) if (item.request.requestId === requestId) return item;
    return undefined;
  }

  function peekForExecution(requestId, actor) {
    if (actor !== 'sidepanel') return undefined;
    return findQueued(requestId)?.request;
  }

  function takeForExecution(requestId, actor) {
    if (actor !== 'sidepanel') return undefined;
    const item = findQueued(requestId);
    if (!item) return undefined;
    queued.delete(item.identity);
    inflight.set(requestId, item);
    persist();
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
    const item = findQueued(requestId);
    if (!item) return false;
    queued.delete(item.identity);
    // It stays remembered: dismissing means "no", and a later rescan must not raise it again.
    persist();
    return true;
  }

  return {
    queueProviderRequest, pending, peekForExecution, takeForExecution, acceptNativeResponse,
    dismiss, restore,
  };
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

  /**
   * One mint in flight per tab.
   *
   * The read and the write are two awaits, so two observations arriving together both saw an
   * empty slot and both minted. The live dogfood showed the consequence: one browser tab became
   * two WAG sessions, which split the tab's workspaces and made the same assistant message look
   * like two different proposals. Sharing the in-flight promise makes the pair atomic enough —
   * there is exactly one worker, so there is no cross-process race to lose.
   */
  const inFlight = new Map();

  function forTab(tabId) {
    const key = keyForTab(tabId);
    const running = inFlight.get(key);
    if (running) return running;

    const started = (async () => {
      const existing = (await storageSession.get(key))?.[key];
      if (typeof existing === 'string' && /^session_[0-9a-f-]{36}$/i.test(existing)) return existing;
      const correlation = `session_${randomUUID()}`;
      if (!/^session_[0-9a-f-]{36}$/i.test(correlation)) throw new Error('Invalid browser correlation');
      await storageSession.set({ [key]: correlation });
      return correlation;
    })().finally(() => {
      if (inFlight.get(key) === started) inFlight.delete(key);
    });

    inFlight.set(key, started);
    return started;
  }

  async function removeTab(tabId) {
    const key = keyForTab(tabId);
    inFlight.delete(key);
    await storageSession.remove(key);
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
