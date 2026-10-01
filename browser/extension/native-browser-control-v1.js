const VERSION = 1;
const REQUEST_ID = /^bctl_[0-9a-f-]{36}$/;
const TARGET_ID = /^tab_[0-9]+$/;
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
]);

export function createNativeBrowserControlV1({ connectNative, control }) {
  let port;

  function ensureConnected() {
    if (port) return port;
    port = connectNative();
    port.onMessage.addListener((message) => {
      void handle(message).then(
        (response) => port?.postMessage(response),
        (error) => {
          const requestId = validRequestId(message?.requestId) ? message.requestId : null;
          if (!requestId || !port) return;
          port.postMessage(errorResponse(
            requestId,
            error?.code ?? 'CONTROL_FAILED',
            error instanceof Error ? error.message : 'Existing browser control failed',
          ));
        },
      );
    });
    port.onDisconnect.addListener(() => { port = undefined; });
    return port;
  }

  async function handle(message) {
    const request = parseRequest(message);
    switch (request.method) {
      case 'targets.list':
        return result(request.requestId, (await control.listTargets()).map((target) => normalizeTarget(target, control)));
      case 'target.group': {
        const id = tabId(request.targetId);
        const grouped = await control.group(id, request.groupTitle);
        return result(request.requestId, {
          targetId: request.targetId,
          groupId: `group_${grouped.groupId}`,
          groupTitle: grouped.groupTitle,
          activeStable: grouped.activeStable === true,
        });
      }
      case 'target.attach': {
        const id = tabId(request.targetId);
        await control.attach(id);
        return result(request.requestId, normalizeTarget(await control.describe(id), control));
      }
      case 'target.describe': {
        const id = tabId(request.targetId);
        return result(request.requestId, normalizeTarget(await control.describe(id), control));
      }
      case 'target.release': {
        const id = tabId(request.targetId);
        const released = await control.release(id);
        return result(request.requestId, { targetId: request.targetId, released: released.released === true });
      }
      case 'target.screenshot':
        return result(request.requestId, await control.screenshot(tabId(request.targetId)));
      case 'target.exec':
        return result(
          request.requestId,
          await control.exec(tabId(request.targetId), request.cdpMethod, request.params),
        );
      default:
        return errorResponse(request.requestId, 'CONTROL_METHOD_DENIED', 'Existing browser method denied');
    }
  }

  return { ensureConnected, handle, isConnected: () => port !== undefined };
}

function parseRequest(value) {
  if (!value || typeof value !== 'object'
      || value.version !== VERSION || value.type !== 'control.request'
      || !validRequestId(value.requestId)) {
    throw new Error('Invalid existing browser control request');
  }
  const method = value.method;
  if (method === 'targets.list') {
    return { version: VERSION, type: 'control.request', requestId: value.requestId, method };
  }
  if (!TARGET_ID.test(value.targetId ?? '')) throw new Error('Invalid existing browser target id');
  if (method === 'target.group') {
    if (typeof value.groupTitle !== 'string' || value.groupTitle.length < 1 || value.groupTitle.length > 64) {
      throw new Error('Invalid existing browser group title');
    }
    return { version: VERSION, type: 'control.request', requestId: value.requestId, method, targetId: value.targetId, groupTitle: value.groupTitle };
  }
  if (method === 'target.exec') {
    if (typeof value.cdpMethod !== 'string' || !ALLOWED_CDP.has(value.cdpMethod)) {
      const error = new Error('Existing browser CDP method denied');
      error.code = 'CONTROL_METHOD_DENIED';
      throw error;
    }
    if (value.params !== undefined
        && (typeof value.params !== 'object' || value.params === null || Array.isArray(value.params))) {
      throw new Error('Invalid existing browser exec params');
    }
    return { ...value };
  }
  if (!['target.attach', 'target.describe', 'target.screenshot', 'target.release'].includes(method)) {
    throw new Error('Invalid existing browser control method');
  }
  return { version: VERSION, type: 'control.request', requestId: value.requestId, method, targetId: value.targetId };
}

function tabId(targetId) {
  const value = Number(targetId.slice('tab_'.length));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid existing browser target id');
  return value;
}

function validRequestId(value) {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

function result(requestId, value) {
  return { version: VERSION, type: 'control.result', requestId, result: value };
}

function errorResponse(requestId, code, message) {
  return {
    version: VERSION,
    type: 'control.error',
    requestId,
    error: {
      code: String(code).slice(0, 128),
      message: String(message).slice(0, 512),
    },
  };
}

function normalizeTarget(value, control) {
  const tab = Number.isInteger(value?.tabId) ? value.tabId : null;
  const windowId = Number.isInteger(value?.windowId) ? value.windowId : null;
  if (tab === null || windowId === null) throw new Error('Invalid existing browser target metadata');
  return {
    targetId: `tab_${tab}`,
    windowId: `window_${windowId}`,
    title: typeof value.title === 'string' ? value.title.slice(0, 256) : '',
    url: typeof value.url === 'string' ? value.url : null,
    origin: typeof value.origin === 'string' ? value.origin : null,
    active: value.active === true,
    attachable: value.attachable === true,
    ownership: 'USER_EXISTING',
    attached: control.isAttached(tab),
  };
}
