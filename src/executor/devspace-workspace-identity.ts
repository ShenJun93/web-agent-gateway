import { gzipSync } from 'node:zlib';
import { SAFE_GIT_RUNNER_SOURCE, minifyHelperSource } from '../safe-git.js';
import type { DevspaceExecutor } from './devspace.js';
import type { WorkspaceIdentityObservation } from '../workspace-identity.js';

const MAX_COMMAND_LENGTH = 8_000;

const WORKSPACE_IDENTITY_HELPER_SOURCE = minifyHelperSource(`
const { realpathSync, statSync } = require('fs');
${SAFE_GIT_RUNNER_SOURCE}

const root = Buffer.from(process.argv[2], 'base64url').toString('utf8');
const nativeRealpath = (value) => realpathSync.native ? realpathSync.native(value) : realpathSync(value);
const realRoot = nativeRealpath(root);
const stat = statSync(realRoot, { bigint: true });
if (!stat.isDirectory()) throw new Error('WORKSPACE_NOT_DIRECTORY');

let gitTopLevel;
let gitDir;
let gitCommonDir;
try {
  const probe = git(['rev-parse', '--show-toplevel'], { cwd: realRoot });
  if (probe.status === 0) {
    gitTopLevel = nativeRealpath(String(probe.stdout).trim());
    gitDir = nativeRealpath(gitOk(['rev-parse', '--absolute-git-dir'], { cwd: realRoot }).trim());
    gitCommonDir = nativeRealpath(gitOk(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: realRoot },
    ).trim());
  }
} finally {
  disposeGitRunner();
}

process.stdout.write(JSON.stringify({
  canonicalRoot: realRoot,
  backendKind: 'devspace',
  fsDevice: String(stat.dev),
  fsInode: String(stat.ino),
  ...(gitTopLevel === undefined ? {} : { gitTopLevel, gitDir, gitCommonDir }),
}));
`);

export async function observeDevspaceWorkspaceIdentity(
  executor: Pick<DevspaceExecutor, 'execCommand' | 'interruptCommand'>,
  devspaceWorkspaceId: string,
  canonicalRoot: string,
): Promise<WorkspaceIdentityObservation> {
  const command = [
    "node -e \"eval(require('zlib').gunzipSync(Buffer.from(process.argv[1],'base64url')).toString('utf8'))\"",
    gzipSync(Buffer.from(WORKSPACE_IDENTITY_HELPER_SOURCE, 'utf8'), { level: 9 }).toString('base64url'),
    Buffer.from(canonicalRoot, 'utf8').toString('base64url'),
  ].join(' ');
  if (command.length > MAX_COMMAND_LENGTH) throw new Error('Gateway rejected workspace identity input');

  const result = await executor.execCommand(devspaceWorkspaceId, command, 2_000, 10_000);
  if (result.running) {
    if (result.sessionId !== undefined) {
      await executor.interruptCommand(devspaceWorkspaceId, result.sessionId, 500);
    }
    throw new Error('Gateway workspace identity helper timed out');
  }
  if ((result.exitCode ?? -1) !== 0) throw new Error('Gateway workspace identity helper failed');

  let parsed: unknown;
  try { parsed = JSON.parse(result.output.trim()); }
  catch { throw new Error('Gateway workspace identity helper returned invalid result'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Gateway workspace identity helper returned invalid result');
  }
  const value = parsed as Record<string, unknown>;
  for (const field of ['canonicalRoot', 'backendKind', 'fsDevice', 'fsInode'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new Error('Gateway workspace identity helper returned invalid result');
    }
  }
  const gitFields = ['gitTopLevel', 'gitDir', 'gitCommonDir'] as const;
  const gitPresent = gitFields.filter((field) => value[field] !== undefined).length;
  if (gitPresent !== 0 && gitPresent !== gitFields.length) {
    throw new Error('Gateway workspace identity helper returned partial Git identity');
  }
  for (const field of gitFields) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].length === 0)) {
      throw new Error('Gateway workspace identity helper returned invalid Git identity');
    }
  }

  return {
    canonicalRoot: value.canonicalRoot as string,
    backendKind: value.backendKind as string,
    fsDevice: value.fsDevice as string,
    fsInode: value.fsInode as string,
    ...(gitPresent === 0 ? {} : {
      gitTopLevel: value.gitTopLevel as string,
      gitDir: value.gitDir as string,
      gitCommonDir: value.gitCommonDir as string,
    }),
  };
}
