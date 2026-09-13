const EXTENSION_ID = /^[a-p]{32}$/;
const WINDOWS_ABSOLUTE_EXE = /^[A-Za-z]:\\.+\.exe$/i;

export interface NativeHostManifest {
  name: 'com.openai.web_agent_gateway';
  description: 'Web Agent Gateway browser adapter';
  path: string;
  type: 'stdio';
  allowed_origins: [string];
}

export function createNativeHostManifest(options: {
  executablePath: string;
  extensionId: string;
}): NativeHostManifest {
  if (!WINDOWS_ABSOLUTE_EXE.test(options.executablePath)) {
    throw new Error('Native host executable path must be a Windows absolute .exe path');
  }
  if (!EXTENSION_ID.test(options.extensionId)) {
    throw new Error('Invalid Chrome extension id');
  }
  return {
    name: 'com.openai.web_agent_gateway',
    description: 'Web Agent Gateway browser adapter',
    path: options.executablePath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${options.extensionId}/`],
  };
}
