const DEFAULT_PROTOCOL_VERSION = '1.3';
const MAX_TITLE_LENGTH = 256;
const MAX_URL_LENGTH = 2048;

export class ExistingBrowserControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExistingBrowserControlError';
    this.code = code;
  }
}

export function createExistingBrowserControlV1(chromeApi, options = {}) {
  const tabs = chromeApi?.tabs;
  const debuggerApi = chromeApi?.debugger;
  if (!tabs?.query || !tabs?.get) throw new Error('tabs API is required');
  if (!debuggerApi?.attach || !debuggerApi?.detach || !debuggerApi?.sendCommand) {
    throw new Error('debugger API is required');
  }

  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  const attached = new Set();

  const onDetach = (source) => {
    if (Number.isInteger(source?.tabId)) attached.delete(source.tabId);
  };
  debuggerApi.onDetach?.addListener?.(onDetach);

  async function listTargets() {
    const rows = await tabs.query({});
    return rows.map(describeTab);
  }

  async function attach(tabId) {
    const tab = await getAttachableTab(tabs, tabId);
    if (!attached.has(tabId)) {
      try {
        await debuggerApi.attach({ tabId }, protocolVersion);
      } catch (error) {
        throw normalizeAttachError(error);
      }
      attached.add(tabId);
    }
    return { ...describeTab(tab), state: 'ATTACHED' };
  }

  async function probe(tabId) {
    assertAttached(attached, tabId);
    const response = await debuggerApi.sendCommand({ tabId }, 'Page.getFrameTree');
    const frameUrl = response?.frameTree?.frame?.url;
    const safe = sanitizeUrl(frameUrl);
    return {
      tabId,
      attached: true,
      origin: safe?.origin ?? null,
      url: safe?.url ?? null,
    };
  }

  async function release(tabId) {
    if (!attached.has(tabId)) return { tabId, released: false };
    try {
      await debuggerApi.detach({ tabId });
    } finally {
      attached.delete(tabId);
    }
    return { tabId, released: true };
  }

  function isAttached(tabId) {
    return attached.has(tabId);
  }

  return { listTargets, attach, probe, release, isAttached };
}

async function getAttachableTab(tabs, tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new ExistingBrowserControlError('TARGET_NOT_FOUND', 'Browser target id is invalid');
  }
  let tab;
  try {
    tab = await tabs.get(tabId);
  } catch {
    throw new ExistingBrowserControlError('TARGET_NOT_FOUND', 'Browser target was not found');
  }
  if (!describeTab(tab).attachable) {
    throw new ExistingBrowserControlError('TARGET_NOT_ATTACHABLE', 'Browser target is not attachable');
  }
  return tab;
}

function assertAttached(attached, tabId) {
  if (!attached.has(tabId)) {
    throw new ExistingBrowserControlError('TARGET_NOT_ATTACHED', 'Browser target is not attached');
  }
}

export function describeExistingBrowserTab(tab) {
  return describeTab(tab);
}

function describeTab(tab) {
  const safe = sanitizeUrl(tab?.url);
  const id = Number.isInteger(tab?.id) ? tab.id : null;
  return {
    tabId: id,
    windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null,
    title: boundedString(tab?.title, MAX_TITLE_LENGTH),
    url: safe?.url ?? null,
    origin: safe?.origin ?? null,
    active: tab?.active === true,
    attachable: id !== null && safe !== null,
    ownership: 'USER_EXISTING',
  };
}

function sanitizeUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const url = parsed.toString();
    return {
      origin: parsed.origin,
      url: url.length <= MAX_URL_LENGTH ? url : parsed.origin + '/',
    };
  } catch {
    return null;
  }
}

function boundedString(value, max) {
  if (typeof value !== 'string') return '';
  return value.length <= max ? value : value.slice(0, max);
}

function normalizeAttachError(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'attach failed');
  const lower = message.toLowerCase();
  if (lower.includes('another debugger') || lower.includes('already attached')) {
    return new ExistingBrowserControlError('DEBUGGER_ALREADY_ATTACHED', 'Browser target already has a debugger');
  }
  if (lower.includes('policy') || lower.includes('enterprise') || lower.includes('not allowed')) {
    return new ExistingBrowserControlError(
      'ATTACH_BLOCKED_BY_BROWSER_POLICY',
      'Browser policy blocked debugger attachment',
    );
  }
  if (lower.includes('permission')) {
    return new ExistingBrowserControlError('ATTACH_PERMISSION_REQUIRED', 'Debugger permission is unavailable');
  }
  return new ExistingBrowserControlError('ATTACH_FAILED', 'Debugger attachment failed');
}
