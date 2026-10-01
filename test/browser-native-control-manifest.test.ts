import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';
import {
  BROWSER_CONTROL_NATIVE_HOST_APPLICATION_NAME,
  createBrowserControlNativeHostManifest,
} from '../src/browser-adapter/native-host-manifest-browser-control.js';
import { parseNativeBrowserControlHostInvocation } from '../src/browser-adapter/native-host-browser-control.js';

test('browser control native host manifest is isolated and pinned to the WAG extension', () => {
  const manifest = createBrowserControlNativeHostManifest({
    executablePath: 'E:\\WAG\\wag-native-browser-control.exe',
    extensionId: BROWSER_ADAPTER_EXTENSION_ID,
  });
  assert.equal(manifest.name, BROWSER_CONTROL_NATIVE_HOST_APPLICATION_NAME);
  assert.equal(manifest.name, 'com.openai.web_agent_gateway_browser_control');
  assert.deepEqual(manifest.allowed_origins, [
    `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`,
  ]);
  assert.notEqual(manifest.name, 'com.openai.web_agent_gateway');
  assert.notEqual(manifest.name, 'com.openai.web_agent_gateway_v5');
});

test('browser control native host invocation accepts only the exact extension origin', () => {
  const origin = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;
  const parsed = parseNativeBrowserControlHostInvocation(
    ['wag-native-browser-control.exe', origin, '--parent-window=123'],
    { LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' },
  );
  assert.equal(parsed.expectedOrigin, origin);
  assert.match(parsed.discoveryPath, /browser-control-v1\.json$/);

  assert.throws(
    () => parseNativeBrowserControlHostInvocation(
      ['wag-native-browser-control.exe', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
      { LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' },
    ),
    /exact extension origin/,
  );
});
