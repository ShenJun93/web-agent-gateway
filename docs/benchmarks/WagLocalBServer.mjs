import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const runtimeRoot = 'E:/WAG-Runtime/7a6e266ac392';
const configPath = process.argv[2];
const receiptPath = 'C:/Users/PACMAP/AppData/Local/WAG-Local/logs/wag-b-runtime.json';
const urlFile = 'E:/AI-BROWSER/wag-acceptance/devspace-state/wag-mutation.sqlite.operator-url';
const expectedSession = 'session_e2dad5f3-4961-4134-b5f9-3a35b58d3248';

const normalizedConfigPath = configPath?.replaceAll('\\', '/');
if (normalizedConfigPath !== 'E:/AI-BROWSER/wag-acceptance/wag-live-b.config.json') {
  throw new Error('unexpected B config path');
}

const mod = async (name) => import(pathToFileURL(runtimeRoot + '/dist/' + name).href);
const { loadPrivateGatewayConfig } = await mod('private-config.js');
const { bootstrapPrivateGateway } = await mod('private-runtime.js');
const { startRepositoryEngineeringRuntime } = await mod('repository-engineering-runtime.js');

const originalUrl = await readFile(urlFile, 'utf8').catch(() => undefined);
const config = await loadPrivateGatewayConfig(configPath);
let engineering;
let privateRuntime;
let shuttingDown = false;

const restoreUrl = async () => {
  if (originalUrl !== undefined) await writeFile(urlFile, originalUrl, 'utf8').catch(() => undefined);
};

try {
  engineering = await startRepositoryEngineeringRuntime(config, {
    startOperatorServer: async () => ({
      origin: 'http://127.0.0.1:1',
      bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=dogfood-placeholder',
      close: async () => {},
    }),
  });
  if (engineering.profile.stableSessionId !== expectedSession) {
    throw new Error('B stable session mismatch: ' + engineering.profile.stableSessionId);
  }

  privateRuntime = await bootstrapPrivateGateway(config, {
    env: process.env,
    openWorkspaceId: engineering.openWorkspaceId,
    bindWorkspaceIdentity: engineering.bindWorkspaceIdentity,
  });
  await engineering.attach(privateRuntime.executor);
  await restoreUrl();

  await writeFile(receiptPath, JSON.stringify({
    state: 'READY',
    pid: process.pid,
    runtimeRoot,
    configPath,
    stableSessionId: engineering.profile.stableSessionId,
    health: privateRuntime.health,
    startedAtUtc: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');

  const keepAlive = setInterval(() => {}, 60_000);
  try {
    await new Promise((resolvePromise) => {
      const finish = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        resolvePromise();
      };
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
    });
  } finally {
    clearInterval(keepAlive);
  }
} finally {
  await engineering?.close().catch(() => undefined);
  await privateRuntime?.close().catch(() => undefined);
  await restoreUrl();
}
