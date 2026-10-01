export const EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION = 1 as const;
export const EXISTING_BROWSER_CONTROL_MAX_BYTES = 256 * 1024;

export type ExistingBrowserControlMethod =
  | 'targets.list'
  | 'target.attach'
  | 'target.describe'
  | 'target.exec'
  | 'target.screenshot'
  | 'target.release';

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
  cdpMethod?: string;
  params?: Readonly<Record<string, unknown>>;
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
  'Input.dispatchMouseEvent',
  'DOM.focus',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'DOM.setFileInputFiles',
  'Page.captureScreenshot',
]);

export function isAllowedExistingBrowserCdpMethod(method: string): boolean {
  return CDP_METHOD.test(method) && ALLOWED_CDP.has(method);
}

export function parseExistingBrowserControlRequest(value: unknown): ExistingBrowserControlRequest {
  const row = record(value, 'control request');
  exactKeys(row, ['version', 'type', 'requestId', 'method', 'targetId', 'cdpMethod', 'params']);
  if (row.version !== EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION || row.type !== 'control.request') {
    throw new Error('Invalid existing browser control request');
  }
  if (typeof row.requestId !== 'string' || !REQUEST_ID.test(row.requestId)) {
    throw new Error('Invalid existing browser control request id');
  }
  const methods: ExistingBrowserControlMethod[] = [
    'targets.list', 'target.attach', 'target.describe', 'target.exec', 'target.screenshot', 'target.release',
  ];
  if (!methods.includes(row.method as ExistingBrowserControlMethod)) {
    throw new Error('Invalid existing browser control method');
  }
  const method = row.method as ExistingBrowserControlMethod;
  if (method === 'targets.list') {
    if (row.targetId !== undefined || row.cdpMethod !== undefined || row.params !== undefined) {
      throw new Error('Invalid existing browser target list request');
    }
  } else {
    if (typeof row.targetId !== 'string' || !TARGET_ID.test(row.targetId)) {
      throw new Error('Invalid existing browser target id');
    }
  }
  if (method === 'target.exec') {
    if (typeof row.cdpMethod !== 'string' || !isAllowedExistingBrowserCdpMethod(row.cdpMethod)) {
      throw new Error('Existing browser CDP method is denied');
    }
    if (row.params !== undefined && !isPlainRecord(row.params)) {
      throw new Error('Invalid existing browser exec params');
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
    ...(row.cdpMethod === undefined ? {} : { cdpMethod: row.cdpMethod as string }),
    ...(row.params === undefined ? {} : { params: row.params as Readonly<Record<string, unknown>> }),
  };
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
