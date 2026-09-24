import { pathToFileURL } from 'node:url';

const runtimeRoot = 'E:/WAG-Runtime/3687bf3b5c18';
const configPath = 'E:/AI-BROWSER/wag-acceptance/wag-live.config.json';
const harnessPath = 'E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1/docs/benchmarks/2026-09-25-live-38-tool-safe-append.mjs';

const mod = async (name: string) => import(pathToFileURL(runtimeRoot + '/dist/' + name).href);
const { loadPrivateGatewayConfig } = await mod('private-config.js');
const { startRepositoryEngineeringRuntime } = await mod('repository-engineering-runtime.js');

const config = await loadPrivateGatewayConfig(configPath);
const engineering = await startRepositoryEngineeringRuntime(config, {
  startOperatorServer: async () => ({
    origin: 'http://127.0.0.1:1',
    bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=live-append-driver',
    close: async () => {},
  }),
});

try {
  const machine = engineering.machineContext;
  if (!machine) throw new Error('machineContext missing');
  const opened = await machine.open('C:/Users/PACMAP/AppData/Local/WAG-Local');
  const workspaceId = (opened as { workspace_id: string }).workspace_id;

  const ps = [
    "$ErrorActionPreference='Stop'",
    "$f=Join-Path $env:LOCALAPPDATA 'WAG-Local\\secrets\\devspace-owner.dpapi'",
    "$secure=ConvertTo-SecureString (Get-Content -LiteralPath $f -Raw)",
    "$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try {",
    "  $env:DEVSPACE_OAUTH_OWNER_TOKEN=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)",
    "  & node.exe '" + harnessPath + "'",
    "  if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}",
    "} finally {",
    "  Remove-Item Env:DEVSPACE_OAUTH_OWNER_TOKEN -ErrorAction SilentlyContinue",
    "  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)",
    "}",
  ].join('; ');

  const result = await machine.commandRun(
    workspaceId,
    ['powershell.exe','-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command',ps],
    { timeoutMs: 120000, maxOutputTokens: 10000 },
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await engineering.close();
}
