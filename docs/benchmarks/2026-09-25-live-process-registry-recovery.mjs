import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const runtimeRoot = 'E:/WAG-Runtime/14d3fd11a409';
const configPath = 'E:/AI-BROWSER/wag-acceptance/wag-live.config.json';
const root = 'E:/WAG-Acceptance/live-process-registry-recovery';
const secretArgument = 'live-registry-secret-must-not-persist';

const mod = async (name) => import(pathToFileURL(runtimeRoot + '/dist/' + name).href);
const { loadPrivateGatewayConfig } = await mod('private-config.js');
const { startRepositoryEngineeringRuntime } = await mod('repository-engineering-runtime.js');

async function runtime() {
  const config = await loadPrivateGatewayConfig(configPath);
  const engineering = await startRepositoryEngineeringRuntime(config, {
    startOperatorServer: async () => ({
      origin: 'http://127.0.0.1:1',
      bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=process-registry-live',
      close: async () => {},
    }),
  });
  return { config, engineering };
}

if (process.argv[2] === 'start') {
  await mkdir(root, { recursive: true });
  const { engineering } = await runtime();
  try {
    const machine = engineering.machineContext;
    if (!machine) throw new Error('machineContext missing');
    const opened = await machine.open(root);
    const started = await machine.processStart(
      opened.workspace_id,
      [
        process.execPath,
        '-e',
        `const secret=${JSON.stringify(secretArgument)}; setInterval(()=>void secret,1000)`,
      ],
    );
    console.log(JSON.stringify({
      stableSessionId: engineering.profile.stableSessionId,
      workspaceId: opened.workspace_id,
      ...started,
    }));
  } finally {
    await engineering.close();
  }
  process.exit(0);
}

if (process.argv[2] === 'recover') {
  const processId = process.argv[3];
  const expectedPid = Number(process.argv[4]);
  if (!processId || !Number.isSafeInteger(expectedPid)) throw new Error('missing recovery args');

  const { config, engineering } = await runtime();
  try {
    const machine = engineering.machineContext;
    if (!machine) throw new Error('machineContext missing');
    const opened = await machine.open(root);
    const inspected = await machine.processInspect(opened.workspace_id, processId);
    if (!inspected.found || inspected.process_id !== processId || inspected.pid !== expectedPid || !inspected.owned) {
      throw new Error('recovered process identity mismatch: ' + JSON.stringify(inspected));
    }

    const statePath = config.repositoryEngineering?.mutation?.statePath;
    const stableSessionId = engineering.profile.stableSessionId;
    if (!statePath || !stableSessionId) throw new Error('stable process registry path unavailable');
    const registryPath = statePath + '.machine-processes.' + stableSessionId + '.json';
    const registry = await readFile(registryPath, 'utf8');
    if (registry.includes(secretArgument)) throw new Error('process registry persisted argv secret');

    const terminated = await machine.processTerminate(opened.workspace_id, processId);
    if (!terminated.terminated || terminated.state !== 'TERMINATED') {
      throw new Error('recovered process termination failed: ' + JSON.stringify(terminated));
    }

    console.log(JSON.stringify({
      stableSessionId,
      reopenedWorkspaceId: opened.workspace_id,
      processId,
      pid: expectedPid,
      recovered: true,
      registrySecretFree: true,
      terminated: true,
      state: terminated.state,
    }));
  } finally {
    await engineering.close();
  }
  process.exit(0);
}

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const start = spawnSync(process.execPath, [import.meta.filename, 'start'], {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 1024 * 1024,
});
if (start.error) throw start.error;
if (start.status !== 0) throw new Error('start subprocess failed: ' + start.stderr);
const started = JSON.parse(start.stdout.trim().split(/\r?\n/).at(-1));

const recover = spawnSync(
  process.execPath,
  [import.meta.filename, 'recover', started.process_id, String(started.pid)],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
);
if (recover.error) throw recover.error;
if (recover.status !== 0) {
  try { process.kill(started.pid, 'SIGTERM'); } catch {}
  throw new Error('recover subprocess failed: ' + recover.stderr + '\n' + recover.stdout);
}
const recovered = JSON.parse(recover.stdout.trim().split(/\r?\n/).at(-1));

console.log(JSON.stringify({
  runtimeRoot,
  separateStartProcess: true,
  separateRecoveryProcess: true,
  initial: started,
  recovery: recovered,
}, null, 2));

await rm(root, { recursive: true, force: true });
