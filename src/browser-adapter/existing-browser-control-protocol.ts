export const EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION = 1 as const;
export const EXISTING_BROWSER_CONTROL_MAX_BYTES = 256 * 1024;

export type ExistingBrowserControlMethod =
  | 'extension.status'
  | 'extension.reload'
  | 'targets.list'
  | 'target.create'
  | 'target.group'
  | 'target.watch'
  | 'target.continuity'
  | 'target.attach'
  | 'target.describe'
  | 'target.exec'
  | 'target.screenshot'
  | 'target.release'
  | 'target.close';

export interface ExistingBrowserTarget {
  targetId: string;
  windowId: string;
  title: string;
  url: string | null;
  origin: string | null;
  active: boolean;
  attachable: boolean;
  ownership: 'USER_EXISTING';
  attached: boolean;
}

export interface ExistingBrowserControlRequest {
  version: typeof EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION;
  type: 'control.request';
  requestId: string;
  method: ExistingBrowserControlMethod;
  targetId?: string;
  currentTargetId?: string;
  groupTitle?: string;
  cdpMethod?: string;
  params?: Readonly<Record<string, unknown>>;
}

export type ExistingBrowserDownloadEventMethod =
  | 'Browser.downloadWillBegin'
  | 'Browser.downloadProgress';

export interface ExistingBrowserControlEvent {
  version: typeof EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION;
  type: 'control.event';
  targetId: string;
  method: ExistingBrowserDownloadEventMethod;
  params: Readonly<Record<string, unknown>>;
}

export interface ExistingBrowserControlResult {
  version: typeof EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION;
  type: 'control.result';
  requestId: string;
  result: unknown;
}

export interface ExistingBrowserControlFailure {
  version: typeof EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION;
  type: 'control.error';
  requestId: string;
  error: { code: string; message: string };
}

export type ExistingBrowserControlResponse =
  | ExistingBrowserControlResult
  | ExistingBrowserControlFailure;

const REQUEST_ID = /^bctl_[0-9a-f-]{36}$/;
const TARGET_ID = /^tab_[0-9]+$/;
const CDP_METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;
const ALLOWED_CDP = new Set([
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
  'Browser.setDownloadBehavior',
]);

export function isAllowedExistingBrowserCdpMethod(method: string): boolean {
  return CDP_METHOD.test(method) && ALLOWED_CDP.has(method);
}

export function parseExistingBrowserControlRequest(value: unknown): ExistingBrowserControlRequest {
  const row = record(value, 'control request');
  exactKeys(row, ['version', 'type', 'requestId', 'method', 'targetId', 'currentTargetId', 'groupTitle', 'cdpMethod', 'params']);
  if (row.version !== EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION || row.type !== 'control.request') {
    throw new Error('Invalid existing browser control request');
  }
  if (typeof row.requestId !== 'string' || !REQUEST_ID.test(row.requestId)) {
    throw new Error('Invalid existing browser control request id');
  }
  const methods: ExistingBrowserControlMethod[] = [
    'extension.status', 'extension.reload',
    'targets.list', 'target.create', 'target.group', 'target.watch', 'target.continuity',
    'target.attach', 'target.describe', 'target.exec', 'target.screenshot', 'target.release', 'target.close',
  ];
  if (!methods.includes(row.method as ExistingBrowserControlMethod)) {
    throw new Error('Invalid existing browser control method');
  }
  const method = row.method as ExistingBrowserControlMethod;
  if (method === 'extension.status' || method === 'extension.reload'
      || method === 'targets.list' || method === 'target.create') {
    if (row.targetId !== undefined || row.currentTargetId !== undefined || row.groupTitle !== undefined || row.cdpMethod !== undefined || row.params !== undefined) {
      throw new Error('Invalid existing browser no-target request');
    }
  } else if (typeof row.targetId !== 'string' || !TARGET_ID.test(row.targetId)) {
    throw new Error('Invalid existing browser target id');
  }
  if (method === 'target.continuity') {
    if (typeof row.currentTargetId !== 'string' || !TARGET_ID.test(row.currentTargetId)) {
      throw new Error('Invalid existing browser current target id');
    }
  } else if (row.currentTargetId !== undefined) {
    throw new Error('Unexpected existing browser current target id');
  }
  if (method === 'target.group') {
    if (typeof row.groupTitle !== 'string' || row.groupTitle.length < 1 || row.groupTitle.length > 64) {
      throw new Error('Invalid existing browser group title');
    }
  } else if (row.groupTitle !== undefined) {
    throw new Error('Unexpected existing browser group title');
  }
  if (method === 'target.exec') {
    if (typeof row.cdpMethod !== 'string' || !isAllowedExistingBrowserCdpMethod(row.cdpMethod)) {
      throw new Error('Existing browser CDP method is denied');
    }
    if (row.params !== undefined && !isPlainRecord(row.params)) {
      throw new Error('Invalid existing browser exec params');
    }
    if (row.cdpMethod === 'Browser.setDownloadBehavior') {
      const params = record(row.params, 'download behavior params');
      exactKeys(params, ['behavior', 'downloadPath', 'eventsEnabled']);
      if (params.behavior !== 'allowAndName'
          || typeof params.downloadPath !== 'string'
          || params.downloadPath.length < 3
          || params.downloadPath.length > 4096
          || params.downloadPath.includes('\0')
          || params.eventsEnabled !== true) {
        throw new Error('Invalid browser download behavior params');
      }
    }
  } else if (row.cdpMethod !== undefined || row.params !== undefined) {
    throw new Error('Unexpected existing browser exec fields');
  }
  return {
    version: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
    type: 'control.request',
    requestId: row.requestId,
    method,
    ...(row.targetId === undefined ? {} : { targetId: row.targetId as string }),
    ...(row.currentTargetId === undefined ? {} : { currentTargetId: row.currentTargetId as string }),
    ...(row.groupTitle === undefined ? {} : { groupTitle: row.groupTitle as string }),
    ...(row.cdpMethod === undefined ? {} : { cdpMethod: row.cdpMethod as string }),
    ...(row.params === undefined ? {} : { params: row.params as Readonly<Record<string, unknown>> }),
  };
}

export function parseExistingBrowserControlEvent(value: unknown): ExistingBrowserControlEvent {
  const row = record(value, 'control event');
  exactKeys(row, ['version', 'type', 'targetId', 'method', 'params']);
  if (row.version !== EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION || row.type !== 'control.event'
      || typeof row.targetId !== 'string' || !TARGET_ID.test(row.targetId)) {
    throw new Error('Invalid existing browser control event');
  }
  if (row.method !== 'Browser.downloadWillBegin' && row.method !== 'Browser.downloadProgress') {
    throw new Error('Invalid existing browser download event method');
  }
  const params = record(row.params, 'download event params');
  if (row.method === 'Browser.downloadWillBegin') {
    exactKeys(params, ['guid', 'url', 'suggestedFilename']);
    if (typeof params.guid !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(params.guid)
        || !validSanitizedDownloadUrl(params.url)
        || typeof params.suggestedFilename !== 'string' || params.suggestedFilename.length < 1
        || Buffer.byteLength(params.suggestedFilename, 'utf8') > 1024
        || /[\u0000-\u001F]/.test(params.suggestedFilename)) {
      throw new Error('Invalid existing browser download begin event');
    }
  } else {
    exactKeys(params, ['guid', 'state']);
    if (typeof params.guid !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(params.guid)
        || !['inProgress', 'completed', 'canceled'].includes(String(params.state))) {
      throw new Error('Invalid existing browser download progress event');
    }
  }
  return {
    version: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
    type: 'control.event',
    targetId: row.targetId,
    method: row.method,
    params,
  } as ExistingBrowserControlEvent;
}

export function parseExistingBrowserControlResponse(value: unknown): ExistingBrowserControlResponse {
  const row = record(value, 'control response');
  if (row.version !== EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION
      || typeof row.requestId !== 'string'
      || !REQUEST_ID.test(row.requestId)) {
    throw new Error('Invalid existing browser control response');
  }
  if (row.type === 'control.result') {
    exactKeys(row, ['version', 'type', 'requestId', 'result']);
    return {
      version: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
      type: 'control.result',
      requestId: row.requestId,
      result: row.result,
    };
  }
  if (row.type === 'control.error') {
    exactKeys(row, ['version', 'type', 'requestId', 'error']);
    const error = record(row.error, 'control error');
    exactKeys(error, ['code', 'message']);
    if (typeof error.code !== 'string' || error.code.length < 1 || error.code.length > 128
        || typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 512) {
      throw new Error('Invalid existing browser control error');
    }
    return {
      version: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
      type: 'control.error',
      requestId: row.requestId,
      error: { code: error.code, message: error.message },
    };
  }
  throw new Error('Invalid existing browser control response type');
}

export function parseExistingBrowserTarget(value: unknown): ExistingBrowserTarget {
  const row = record(value, 'browser target');
  exactKeys(row, [
    'targetId', 'windowId', 'title', 'url', 'origin', 'active', 'attachable', 'ownership', 'attached',
  ]);
  if (typeof row.targetId !== 'string' || !TARGET_ID.test(row.targetId)
      || typeof row.windowId !== 'string' || !/^window_[0-9]+$/.test(row.windowId)
      || typeof row.title !== 'string' || row.title.length > 256
      || (row.url !== null && (typeof row.url !== 'string' || row.url.length > 2048))
      || (row.origin !== null && (typeof row.origin !== 'string' || row.origin.length > 2048))
      || typeof row.active !== 'boolean' || typeof row.attachable !== 'boolean'
      || row.ownership !== 'USER_EXISTING' || typeof row.attached !== 'boolean') {
    throw new Error('Invalid existing browser target');
  }
  return row as unknown as ExistingBrowserTarget;
}

function validSanitizedDownloadUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16 * 1024) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error('Invalid existing browser ' + label);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(row)) if (!allowedSet.has(key)) {
    throw new Error('Unexpected existing browser control field');
  }
}
