const EXTENSION_ID = /^[a-p]{32}$/;
const WINDOWS_ABSOLUTE_EXE = /^[A-Za-z]:\\.+\.exe$/i;

/**
 * The native-messaging manifest for the delegated-dispatch host (ADR-0029).
 *
 * A parallel file to `native-host-manifest.ts`, and a **different application name**, because the
 * extension has to be able to open two ports at once: the v4 operator host and this one. Chrome
 * resolves a host by its application name, so one name means one host — and reusing v4's would not
 * give the extension a choice, it would silently replace the operator adapter with this one.
 *
 * `com.openai.web_agent_gateway_v5` is registered separately and can be absent. That is the
 * ordinary state of a machine that has not enabled delegated Run: `chrome.runtime.connectNative`
 * fails, the extension's `tryDelegatedRun` gives up quietly, and every proposal waits for a person.
 * Fail-closed is the direction that has to be true here.
 *
 * The same origin pin applies. One extension id, exactly, not a shape.
 */
export interface DelegationNativeHostManifest {
  name: 'com.openai.web_agent_gateway_v5';
  description: 'Web Agent Gateway delegated dispatch adapter';
  path: string;
  type: 'stdio';
  allowed_origins: [string];
}

export const DELEGATION_NATIVE_HOST_APPLICATION_NAME = 'com.openai.web_agent_gateway_v5' as const;

export function createDelegationNativeHostManifest(options: {
  executablePath: string;
  extensionId: string;
}): DelegationNativeHostManifest {
  if (!WINDOWS_ABSOLUTE_EXE.test(options.executablePath)) {
    throw new Error('Native host executable path must be a Windows absolute .exe path');
  }
  if (!EXTENSION_ID.test(options.extensionId)) {
    throw new Error('Invalid Chrome extension id');
  }
  return {
    name: DELEGATION_NATIVE_HOST_APPLICATION_NAME,
    description: 'Web Agent Gateway delegated dispatch adapter',
    path: options.executablePath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${options.extensionId}/`],
  };
}
