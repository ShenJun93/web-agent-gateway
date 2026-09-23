/**
 * Read-only operator utility for measuring the stable workspace identity used by Goal Lease v1.
 *
 * This script does not open the authority database and cannot issue, revoke, renew or activate a
 * lease. Its output is review material for a later human-issued identity-bound successor.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildSafeGitEnv, SAFE_GIT_BASE_ARGS } from '../src/safe-git.js';
import {
  workspaceIdentityFingerprint,
  type WorkspaceIdentityObservation,
} from '../src/workspace-identity.js';

export interface WorkspaceIdentityMeasurement {
  readonly version: 'wag.workspace-identity.measurement.v1';
  readonly fingerprint: string;
  readonly workspaceIdentity: {
    readonly workspaceRoot: string;
    readonly fingerprint: string;
  };
  readonly observation: WorkspaceIdentityObservation;
}

function nativeRealpath(value: string): string {
  return realpathSync.native ? realpathSync.native(value) : realpathSync(value);
}

function git(root: string, args: readonly string[], allowFailure = false): string | undefined {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git';
  const result = spawnSync(executable, [...SAFE_GIT_BASE_ARGS, '-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSafeGitEnv(process.env),
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return undefined;
    throw new Error(
      'git failed (' + String(result.status) + ') in ' + root + ': '
      + String(result.stderr ?? '').trim().split('\n')[0],
    );
  }
  return String(result.stdout ?? '').trim();
}

export function measureWorkspaceIdentity(root: string): WorkspaceIdentityMeasurement {
  if (!isAbsolute(root)) throw new Error('--root must be an absolute path');
  const realRoot = nativeRealpath(root);
  const stat = statSync(realRoot, { bigint: true });
  if (!stat.isDirectory()) throw new Error('workspace root is not a directory');

  const probe = git(realRoot, ['rev-parse', '--show-toplevel'], true);
  let gitTopLevel: string | undefined;
  let gitDir: string | undefined;
  let gitCommonDir: string | undefined;
  if (probe !== undefined) {
    gitTopLevel = nativeRealpath(probe);
    gitDir = nativeRealpath(git(realRoot, ['rev-parse', '--absolute-git-dir'])!);
    gitCommonDir = nativeRealpath(git(
      realRoot,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    )!);
  }

  const observation: WorkspaceIdentityObservation = {
    canonicalRoot: realRoot,
    backendKind: 'devspace',
    fsDevice: String(stat.dev),
    fsInode: String(stat.ino),
    ...(gitTopLevel === undefined ? {} : { gitTopLevel, gitDir, gitCommonDir }),
  };
  const fingerprint = workspaceIdentityFingerprint(observation);
  return {
    version: 'wag.workspace-identity.measurement.v1',
    fingerprint,
    workspaceIdentity: { workspaceRoot: realRoot, fingerprint },
    observation,
  };
}

function usage(): string {
  return [
    'Usage:',
    '  npx tsx scripts/measure-workspace-identity.ts --root <absolute-workspace-root>',
    '',
    'Read-only: prints the stable workspace fingerprint and binding fragment; changes no authority.',
  ].join('\n');
}

function cli(argv: readonly string[]): number {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  if (argv.length !== 2 || argv[0] !== '--root') {
    process.stderr.write(usage() + '\n');
    return 1;
  }
  try {
    process.stdout.write(JSON.stringify(measureWorkspaceIdentity(argv[1]!), null, 2) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    return 1;
  }
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = cli(process.argv.slice(2));
}
