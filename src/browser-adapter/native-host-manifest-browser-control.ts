const EXTENSION_ID = /^[a-p]{32}$/;
const WINDOWS_ABSOLUTE_EXE = /^[A-Za-z]:\\.+\.exe$/i;

export const BROWSER_CONTROL_NATIVE_HOST_APPLICATION_NAME =
  'com.openai.web_agent_gateway_browser_control' as const;

export interface BrowserControlNativeHostManifest {
  name: typeof BROWSER_CONTROL_NATIVE_HOST_APPLICATION_NAME;
  description: 'Web Agent Gateway existing-browser control adapter';
  path: string;
  type: 'stdio';
  allowed_origins: [string];
}

export function createBrowserControlNativeHostManifest(options: {
  executablePath: string;
  extensionId: string;
}): BrowserControlNativeHostManifest {
  if (!WINDOWS_ABSOLUTE_EXE.test(options.executablePath)) {
    throw new Error('Native host executable path must be a Windows absolute .exe path');
  }
  if (!EXTENSION_ID.test(options.extensionId)) throw new Error('Invalid Chrome extension id');
  return {
    name: BROWSER_CONTROL_NATIVE_HOST_APPLICATION_NAME,
    description: 'Web Agent Gateway existing-browser control adapter',
    path: options.executablePath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${options.extensionId}/`],
  };
}
