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
  const tabGroups = chromeApi?.tabGroups;
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

  async function group(tabId, title = 'WAG • AI') {
    const tab = await getAttachableTab(tabs, tabId);
    if (!tabs.group || !tabGroups?.update) {
      throw new ExistingBrowserControlError('TAB_GROUPS_UNAVAILABLE', 'Browser tab groups are unavailable');
    }
    const activeBefore = (await tabs.query({ active: true, windowId: tab.windowId }))[0]?.id ?? null;
    const groupId = await tabs.group({ tabIds: [tabId] });
    await tabGroups.update(groupId, {
      title: boundedString(title, 64) || 'WAG • AI',
      color: 'cyan',
      collapsed: false,
    });
    const activeAfter = (await tabs.query({ active: true, windowId: tab.windowId }))[0]?.id ?? null;
    return {
      tabId,
      groupId,
      groupTitle: boundedString(title, 64) || 'WAG • AI',
      activeStable: activeBefore === activeAfter,
    };
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

  async function describe(tabId) {
    const tab = await getAttachableTab(tabs, tabId);
    return { ...describeTab(tab), attached: attached.has(tabId) };
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

  async function exec(tabId, method, params) {
    assertAttached(attached, tabId);
    assertAllowedCdpMethod(method);
    if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params))) {
      throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'Browser command params are invalid');
    }
    assertBoundedRuntimeCommand(method, params);
    return debuggerApi.sendCommand({ tabId }, method, params);
  }

  async function screenshot(tabId) {
    const value = await exec(tabId, 'Page.captureScreenshot', { format: 'png' });
    if (typeof value?.data !== 'string') {
      throw new ExistingBrowserControlError('SCREENSHOT_FAILED', 'Browser screenshot returned no data');
    }
    return { mimeType: 'image/png', dataBase64: value.data };
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

  return { listTargets, group, attach, describe, probe, exec, screenshot, release, isAttached };
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

const ALLOWED_CDP_METHODS = new Set([
  'Accessibility.getFullAXTree',
  'Page.navigate',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.getBoxModel',
  'DOM.resolveNode',
  'Runtime.callFunctionOn',
  'Runtime.releaseObject',
  'Input.dispatchMouseEvent',
  'DOM.focus',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'DOM.setFileInputFiles',
  'Page.captureScreenshot',
]);

function assertAllowedCdpMethod(method) {
  if (typeof method !== 'string' || !ALLOWED_CDP_METHODS.has(method)) {
    throw new ExistingBrowserControlError('CONTROL_METHOD_DENIED', 'Browser command is not allowed');
  }
}

const FIXED_DOM_CLICK_FUNCTION = 'function(){if(typeof this.click==="function"){this.click();return true;}return false;}';

function assertBoundedRuntimeCommand(method, params) {
  if (method === 'DOM.resolveNode') {
    const keys = Object.keys(params ?? {});
    if (keys.length !== 1 || keys[0] !== 'backendNodeId' || !Number.isInteger(params?.backendNodeId)) {
      throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'DOM resolve params are invalid');
    }
    return;
  }
  if (method === 'Runtime.callFunctionOn') {
    const keys = Object.keys(params ?? {}).sort();
    if (keys.join(',') !== 'functionDeclaration,objectId,returnByValue'
        || typeof params?.objectId !== 'string' || params.objectId.length < 1 || params.objectId.length > 512
        || params.functionDeclaration !== FIXED_DOM_CLICK_FUNCTION
        || params.returnByValue !== true) {
      throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'Runtime call params are invalid');
    }
    return;
  }
  if (method === 'Runtime.releaseObject') {
    const keys = Object.keys(params ?? {});
    if (keys.length !== 1 || keys[0] !== 'objectId'
        || typeof params?.objectId !== 'string' || params.objectId.length < 1 || params.objectId.length > 512) {
      throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'Runtime release params are invalid');
    }
  }
}
