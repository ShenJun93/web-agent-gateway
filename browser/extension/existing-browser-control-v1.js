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
  const continuityWatches = new Map();
  const targetActivity = new Map();
  let activitySequence = 0;

  function rememberTab(tab, sequence = 0) {
    if (!Number.isInteger(tab?.id)) return;
    const current = targetActivity.get(tab.id);
    const openerTabId = Number.isInteger(tab?.openerTabId)
      ? tab.openerTabId
      : current?.openerTabId ?? null;
    targetActivity.set(tab.id, {
      openerTabId,
      sequence: Math.max(current?.sequence ?? 0, sequence),
    });
  }

  tabs.onCreated?.addListener?.((tab) => {
    activitySequence += 1;
    rememberTab(tab, activitySequence);
  });
  tabs.onUpdated?.addListener?.((tabId, changeInfo, tab) => {
    if (typeof changeInfo?.url !== 'string') return;
    activitySequence += 1;
    rememberTab({ ...tab, id: tabId }, activitySequence);
  });

  const onDetach = (source) => {
    if (Number.isInteger(source?.tabId)) attached.delete(source.tabId);
  };
  debuggerApi.onDetach?.addListener?.(onDetach);

  async function listTargets() {
    const rows = await tabs.query({});
    for (const row of rows) rememberTab(row);
    return rows.map(describeTab);
  }

  async function watchContinuity(tabId) {
    await getAttachableTab(tabs, tabId);
    const rows = await tabs.query({});
    for (const row of rows) rememberTab(row);
    continuityWatches.set(tabId, { baselineSequence: activitySequence });
    return { tabId, baselineSequence: activitySequence };
  }

  async function resolveContinuity(rootTabId, currentTabId) {
    const watch = continuityWatches.get(rootTabId);
    if (!watch) {
      throw new ExistingBrowserControlError('CONTINUITY_NOT_WATCHED', 'Browser target continuity is not active');
    }
    const rows = await tabs.query({});
    for (const row of rows) rememberTab(row);
    const byId = new Map(rows.filter((row) => Number.isInteger(row?.id)).map((row) => [row.id, row]));
    const root = byId.get(rootTabId);
    const current = byId.get(currentTabId);

    if (!current && root && describeTab(root).attachable) {
      return {
        sequence: activitySequence,
        reason: 'CURRENT_GONE',
        target: describeTab(root),
      };
    }

    let selected = null;
    let selectedSequence = watch.baselineSequence;
    for (const row of rows) {
      if (!Number.isInteger(row?.id) || !describeTab(row).attachable) continue;
      if (row.id !== rootTabId && !descendsFrom(row.id, rootTabId, targetActivity)) continue;
      const sequence = targetActivity.get(row.id)?.sequence ?? 0;
      if (sequence <= watch.baselineSequence || sequence < selectedSequence) continue;
      if (sequence === selectedSequence && selected && row.id <= selected.id) continue;
      selected = row;
      selectedSequence = sequence;
    }

    return {
      sequence: activitySequence,
      reason: selected
        ? (selected.id === rootTabId ? 'ROOT_UPDATED' : 'SUCCESSOR')
        : 'NO_CHANGE',
      target: selected ? describeTab(selected) : null,
    };
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

  return {
    listTargets,
    watchContinuity,
    resolveContinuity,
    group,
    attach,
    describe,
    probe,
    exec,
    screenshot,
    release,
    isAttached,
  };
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

function descendsFrom(tabId, rootTabId, activity) {
  let current = tabId;
  const seen = new Set();
  for (let depth = 0; depth < 16; depth += 1) {
    if (current === rootTabId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const opener = activity.get(current)?.openerTabId;
    if (!Number.isInteger(opener)) return false;
    current = opener;
  }
  return false;
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
const FIXED_NATIVE_VALUE_FILL_FUNCTION = "function(value){let proto=null;if(this instanceof HTMLInputElement)proto=HTMLInputElement.prototype;else if(this instanceof HTMLTextAreaElement)proto=HTMLTextAreaElement.prototype;else return {supported:false,value:null};const descriptor=Object.getOwnPropertyDescriptor(proto,\"value\");if(!descriptor||typeof descriptor.set!==\"function\")return {supported:false,value:null};descriptor.set.call(this,value);this.dispatchEvent(new Event(\"input\",{bubbles:true}));this.dispatchEvent(new Event(\"change\",{bubbles:true}));return {supported:true,value:this.value};}";
const FIXED_CONTENTEDITABLE_SELECT_ALL_FUNCTION = "function(){if(!(this instanceof HTMLElement)||!this.isContentEditable)return false;this.focus();const selection=this.ownerDocument.getSelection();if(!selection)return false;const range=this.ownerDocument.createRange();range.selectNodeContents(this);selection.removeAllRanges();selection.addRange(range);return true;}";
const FIXED_MEDIA_INSPECT_FUNCTION = "function(){if(!(this instanceof HTMLMediaElement))return {supported:false};const decoded=typeof this.webkitAudioDecodedByteCount===\"number\"?this.webkitAudioDecodedByteCount:null;const tracks=this.audioTracks&&typeof this.audioTracks.length===\"number\"?this.audioTracks.length:null;let captured=null;try{const stream=typeof this.captureStream===\"function\"?this.captureStream():null;captured=stream&&typeof stream.getAudioTracks===\"function\"?stream.getAudioTracks().length:null;}catch{}const duration=Number.isFinite(this.duration)?this.duration:null;const currentTime=Number.isFinite(this.currentTime)?this.currentTime:null;const error=this.error?{code:this.error.code,message:String(this.error.message||\"\").slice(0,256)}:null;return {supported:true,tag:String(this.tagName||\"\").toLowerCase(),paused:this.paused===true,ended:this.ended===true,muted:this.muted===true,volume:this.volume,duration,currentTime,playbackRate:this.playbackRate,readyState:this.readyState,networkState:this.networkState,error,audioDecodedBytes:decoded,audioTrackCount:tracks,capturedAudioTrackCount:captured,videoWidth:typeof this.videoWidth===\"number\"?this.videoWidth:null,videoHeight:typeof this.videoHeight===\"number\"?this.videoHeight:null};}";
const MAX_FILL_TEXT_BYTES = 64 * 1024;

function assertBoundedRuntimeCommand(method, params) {
  if (method === 'DOM.resolveNode') {
    const keys = Object.keys(params ?? {});
    if (keys.length !== 1 || keys[0] !== 'backendNodeId' || !Number.isInteger(params?.backendNodeId)) {
      throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'DOM resolve params are invalid');
    }
    return;
  }
  if (method === 'Runtime.callFunctionOn') {
    const objectId = params?.objectId;
    if (typeof objectId !== 'string' || objectId.length < 1 || objectId.length > 512
        || params?.returnByValue !== true) {
      throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'Runtime call params are invalid');
    }

    if (params.functionDeclaration === FIXED_DOM_CLICK_FUNCTION) {
      const keys = Object.keys(params ?? {}).sort();
      if (keys.join(',') !== 'functionDeclaration,objectId,returnByValue,userGesture'
          || params.userGesture !== true) {
        throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'Runtime click params are invalid');
      }
      return;
    }

    if (params.functionDeclaration === FIXED_CONTENTEDITABLE_SELECT_ALL_FUNCTION) {
      const keys = Object.keys(params ?? {}).sort();
      if (keys.join(',') !== 'functionDeclaration,objectId,returnByValue') {
        throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'Runtime fixed-function params are invalid');
      }
      return;
    }

    if (params.functionDeclaration === FIXED_NATIVE_VALUE_FILL_FUNCTION) {
      const keys = Object.keys(params ?? {}).sort();
      const args = params.arguments;
      const arg = Array.isArray(args) && args.length === 1 ? args[0] : undefined;
      if (keys.join(',') !== 'arguments,functionDeclaration,objectId,returnByValue'
          || !arg || typeof arg !== 'object' || Array.isArray(arg)
          || Object.keys(arg).length !== 1
          || typeof arg.value !== 'string'
          || arg.value.includes('\0')
          || new TextEncoder().encode(arg.value).byteLength > MAX_FILL_TEXT_BYTES) {
        throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'Runtime fill params are invalid');
      }
      return;
    }

    if (params.functionDeclaration === FIXED_MEDIA_INSPECT_FUNCTION) {
      const keys = Object.keys(params ?? {}).sort();
      if (keys.join(',') !== 'functionDeclaration,objectId,returnByValue') {
        throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'Runtime media inspect params are invalid');
      }
      return;
    }

    throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'Runtime function is not allowed');
  }
  if (method === 'Runtime.releaseObject') {
    const keys = Object.keys(params ?? {});
    if (keys.length !== 1 || keys[0] !== 'objectId'
        || typeof params?.objectId !== 'string' || params.objectId.length < 1 || params.objectId.length > 512) {
      throw new ExistingBrowserControlError('CONTROL_PARAMS_INVALID', 'Runtime release params are invalid');
    }
  }
}
