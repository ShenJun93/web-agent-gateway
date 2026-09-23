import { gzipSync } from 'node:zlib';
import { minifyHelperSource } from '../safe-git.js';
import type { DevspaceExecutor } from './devspace.js';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_COMMAND_LENGTH = 8_000;

export interface DevspaceRawFileIdentity {
  rawSha256: string;
  sizeBytes: number;
  bom: boolean;
  newlineMode: 'NONE' | 'LF' | 'CRLF' | 'MIXED';
}

const RAW_IDENTITY_HELPER_SOURCE = minifyHelperSource(`
const { readFileSync } = require('fs');
const { createHash } = require('crypto');

const path = Buffer.from(process.argv[2], 'base64url').toString('utf8');
const bytes = readFileSync(path);
if (bytes.length > 65536) {
  process.stderr.write('FILE_TOO_LARGE');
  process.exit(2);
}

let crlf = 0;
let lf = 0;
for (let i = 0; i < bytes.length; i += 1) {
  if (bytes[i] !== 10) continue;
  if (i > 0 && bytes[i - 1] === 13) crlf += 1;
  else lf += 1;
}
const newlineMode = crlf > 0 && lf > 0 ? 'MIXED'
  : crlf > 0 ? 'CRLF'
    : lf > 0 ? 'LF'
      : 'NONE';

process.stdout.write(JSON.stringify({
  rawSha256: createHash('sha256').update(bytes).digest('hex'),
  sizeBytes: bytes.length,
  bom: bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
  newlineMode,
}));
`);

export async function readDevspaceRawFileIdentity(
  executor: Pick<DevspaceExecutor, 'execCommand' | 'interruptCommand'>,
  workspaceId: string,
  path: string,
): Promise<DevspaceRawFileIdentity> {
  const command = [
    "node -e \"eval(require('zlib').gunzipSync(Buffer.from(process.argv[1],'base64url')).toString('utf8'))\"",
    gzipSync(Buffer.from(RAW_IDENTITY_HELPER_SOURCE, 'utf8'), { level: 9 }).toString('base64url'),
    Buffer.from(path, 'utf8').toString('base64url'),
  ].join(' ');
  if (command.length > MAX_COMMAND_LENGTH) throw new Error('Gateway rejected raw identity input');

  const result = await executor.execCommand(workspaceId, command, 1_000, 10_000);
  if (result.running) {
    if (result.sessionId !== undefined) {
      await executor.interruptCommand(workspaceId, result.sessionId, 500);
    }
    throw new Error('Gateway raw identity helper timed out');
  }
  if ((result.exitCode ?? -1) !== 0) {
    if (result.output.includes('FILE_TOO_LARGE')) throw new Error('Gateway rejected oversized content');
    throw new Error('Gateway raw identity helper failed');
  }

  let parsed: unknown;
  try { parsed = JSON.parse(result.output.trim()); }
  catch { throw new Error('Gateway raw identity helper returned invalid result'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Gateway raw identity helper returned invalid result');
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.rawSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.rawSha256)
    || typeof value.sizeBytes !== 'number'
    || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 0
    || typeof value.bom !== 'boolean'
    || !['NONE', 'LF', 'CRLF', 'MIXED'].includes(String(value.newlineMode))
  ) {
    throw new Error('Gateway raw identity helper returned invalid result');
  }
  return {
    rawSha256: value.rawSha256,
    sizeBytes: value.sizeBytes,
    bom: value.bom,
    newlineMode: value.newlineMode as DevspaceRawFileIdentity['newlineMode'],
  };
}
