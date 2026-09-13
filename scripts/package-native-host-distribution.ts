import { isAbsolute } from 'node:path';
import { writeNativeHostDistributionBundle } from '../src/browser-adapter/native-host-distribution.js';

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const executablePath = option(args, '--executable');
  const packageLockPath = option(args, '--package-lock');
  const outputDir = option(args, '--output');
  for (const path of [executablePath, packageLockPath, outputDir]) {
    if (!isAbsolute(path)) throw new Error('Distribution paths must be absolute');
  }
  const imageOS = process.env.ImageOS;
  const imageVersion = process.env.ImageVersion;
  const receipt = await writeNativeHostDistributionBundle({
    executablePath,
    packageLockPath,
    outputDir,
    metadata: {
      repository: env('GITHUB_REPOSITORY'),
      sourceSha: env('GITHUB_SHA'),
      sourceRef: env('GITHUB_REF'),
      workflowRunId: env('GITHUB_RUN_ID'),
      runAttempt: Number(env('GITHUB_RUN_ATTEMPT')),
      runner: {
        os: env('RUNNER_OS') as 'Windows',
        arch: env('RUNNER_ARCH') as 'X64',
        ...(imageOS ? { imageOS } : {}),
        ...(imageVersion ? { imageVersion } : {}),
      },
    },
  });
  process.stdout.write(`${JSON.stringify({ status: 'packaged', sourceSha: receipt.sourceSha, sha256: receipt.artifact.sha256 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`wag-native-host-package: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
});
