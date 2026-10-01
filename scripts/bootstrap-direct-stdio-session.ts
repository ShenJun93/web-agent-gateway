import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadPrivateGatewayConfig } from '../src/private-config.js';
import { startRepositoryEngineeringRuntime } from '../src/repository-engineering-runtime.js';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i < 0 ? undefined : process.argv[i + 1];
  if (!value) throw new Error('Missing ' + name);
  return resolve(value);
}

const templatePath = arg('--template');
const outputPath = arg('--output');

if (dirname(templatePath) !== dirname(outputPath)) {
  throw new Error('Fresh direct-session config must be created beside its reviewed template');
}
if (!/^wag-live-[a-z0-9-]+\.config\.json$/i.test(outputPath.split(/[\\/]/).at(-1) ?? '')) {
  throw new Error('Output must use wag-live-<lane>.config.json naming');
}

const templateText = await readFile(templatePath, 'utf8');
const template = JSON.parse(templateText) as {
  repositoryEngineering?: {
    mutation?: {
      sessionCorrelation?: string;
      goalLeaseId?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
const mutation = template.repositoryEngineering?.mutation;
if (!mutation) throw new Error('Template has no repositoryEngineering.mutation');

const freshCorrelation = 'session_' + randomUUID();
const candidate = structuredClone(template);
const candidateMutation = candidate.repositoryEngineering!.mutation!;
candidateMutation.sessionCorrelation = freshCorrelation;
// goalLeaseId is a legacy selector and no longer activates authority. Do not copy a misleading
// lane-B lease label into a freshly minted lane-C identity.
delete candidateMutation.goalLeaseId;

const text = JSON.stringify(candidate, null, 2) + '\n';
await writeFile(outputPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

let runtime;
try {
  const parsed = await loadPrivateGatewayConfig(outputPath);
  runtime = await startRepositoryEngineeringRuntime(parsed);
  const stableSessionId = runtime.profile.stableSessionId;
  if (!stableSessionId?.startsWith('session_')) {
    throw new Error('Fresh config did not materialize a stable durable session');
  }
  const receiptPath = outputPath.replace(/\.config\.json$/i, '.session-bootstrap.json');
  await writeFile(receiptPath, JSON.stringify({
    version: 'wag.direct-stdio-session-bootstrap.v1',
    configPath: outputPath,
    stableSessionId,
    createdAtUtc: new Date().toISOString(),
    authorityGranted: false,
    note: 'Fresh identity only. No Goal Lease was issued or activated.',
  }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });

  console.log('DIRECT_STDIO_SESSION_BOOTSTRAP_OK=True');
  console.log('CONFIG=' + outputPath);
  console.log('STABLE_SESSION_ID=' + stableSessionId);
  console.log('AUTHORITY_GRANTED=False');
  console.log('CORRELATION_EXPOSED=False');
} finally {
  await runtime?.close();
}
