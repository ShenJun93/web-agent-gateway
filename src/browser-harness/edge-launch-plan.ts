import { isAbsolute } from 'node:path';
import type { BrowserExecutionMode, BrowserProfileHandle } from './browser-port.js';

export interface EdgeCdpLaunchPlan {
  readonly executablePath: string;
  readonly argv: readonly string[];
  readonly endpointUrl: string;
  readonly profileId: string;
  readonly userDataDir: string;
  readonly debugPort: number;
  readonly executionMode: Exclude<BrowserExecutionMode, 'ATTACH_EXISTING'>;
}

const RESERVED = [
  '--user-data-dir',
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--headless',
];

function reservedArgument(argument: string): boolean {
  const lower = argument.toLowerCase();
  return RESERVED.some((prefix) => lower === prefix || lower.startsWith(`${prefix}=`));
}

export function createEdgeCdpLaunchPlan(options: {
  executablePath: string;
  profile: BrowserProfileHandle;
  debugPort: number;
  executionMode?: Exclude<BrowserExecutionMode, 'ATTACH_EXISTING'>;
  initialUrl?: string;
  extraArgs?: readonly string[];
}): EdgeCdpLaunchPlan {
  if (!isAbsolute(options.executablePath)) throw new Error('Edge executable path must be absolute');
  if (!options.profile.userDataDir || !isAbsolute(options.profile.userDataDir)) {
    throw new Error('Edge BrowserPort requires an absolute dedicated profile directory');
  }
  if (!Number.isInteger(options.debugPort) || options.debugPort < 1024 || options.debugPort > 65535) {
    throw new Error('Edge CDP port must be an integer from 1024 through 65535');
  }
  for (const argument of options.extraArgs ?? []) {
    if (reservedArgument(argument)) throw new Error(`Edge launch argument is reserved: ${argument}`);
  }

  const initialUrl = options.initialUrl ?? 'about:blank';
  const executionMode = options.executionMode ?? 'WAG_HEADLESS';
  const argv = Object.freeze([
    `--user-data-dir=${options.profile.userDataDir}`,
    `--remote-debugging-port=${options.debugPort}`,
    ...(executionMode === 'WAG_HEADLESS' ? ['--headless=new'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.extraArgs ?? []),
    initialUrl,
  ]);

  return Object.freeze({
    executablePath: options.executablePath,
    argv,
    endpointUrl: `http://127.0.0.1:${options.debugPort}`,
    profileId: options.profile.profileId,
    userDataDir: options.profile.userDataDir,
    debugPort: options.debugPort,
    executionMode,
  });
}
