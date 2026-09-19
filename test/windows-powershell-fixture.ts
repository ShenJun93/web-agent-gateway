import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Windows PowerShell 5.1 must derive its own native module path. A PowerShell 7
// parent exports a process-scoped PSModulePath naming PS7's module directories;
// inheriting it makes WinPS 5.1 resolve incompatible 7.0.0.0 module copies and
// lose built-ins these scripts need, such as Get-FileHash.
export function windowsPowerShellChildEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  return env;
}

/**
 * Builds a PSModulePath entry that shadows a built-in Windows PowerShell module
 * with a manifest claiming `Get-FileHash` but whose root module cannot load.
 *
 * This reproduces the PS7-inheritance failure mode hermetically: a WinPS 5.1
 * process that inherits the returned path loses `Get-FileHash`, without the
 * test depending on PowerShell 7 actually being installed.
 */
export async function createShadowedPSModulePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wag-hostile-psmodulepath-'));
  const modules = join(root, 'Modules');
  const shadow = join(modules, 'Microsoft.PowerShell.Utility');
  await mkdir(shadow, { recursive: true });
  await writeFile(join(shadow, 'Microsoft.PowerShell.Utility.psd1'), [
    '@{',
    "  ModuleVersion = '9.9.9'",
    "  GUID = '1d73a601-4a6c-43c5-ba3f-619b18bbb404'",
    "  RootModule = 'WagHostileShadowDoesNotExist.dll'",
    "  CmdletsToExport = @('Get-FileHash')",
    '  FunctionsToExport = @()',
    '  AliasesToExport = @()',
    '}',
    '',
  ].join('\n'), 'utf8');
  return modules;
}
