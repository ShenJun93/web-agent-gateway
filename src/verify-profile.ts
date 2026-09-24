import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { buildVerifyCommand } from './verify-runner.js';

export interface VerifyProfile {
  argv: readonly string[];
  timeoutMs?: number;
  maxOutputTokens?: number;
  env?: Readonly<Record<string, string>>;
  resumeQueuedAfterRestart?: boolean;
}

export interface ResolvedVerifyProfile {
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputTokens: number;
  resumeQueuedAfterRestart: boolean;
  cwd: string;
  executionRoot?: string;
  command: string;
  planSha256: string;
}

const SAFE_ARG = /^[A-Za-z0-9_./:\\+=@-]{1,512}$/;
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ENV_KEY = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;
export function resolveVerifyProfile(
  profile: VerifyProfile,
  cwd = '.',
  executionRoot?: string,
): ResolvedVerifyProfile {
  if (profile.argv.length < 1 || profile.argv.length > 16) throw new Error('Invalid verify profile argv');
  if (!profile.argv.every((arg) => SAFE_ARG.test(arg))) throw new Error('Invalid verify profile argv');

  const envEntries = Object.entries(profile.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (envEntries.length > 16) throw new Error('Invalid verify profile env');
  if (envEntries.some(([key, value]) => !SAFE_ENV_KEY.test(key) || !SAFE_ARG.test(value) || SECRET_ENV_KEY.test(key))) {
    throw new Error('Invalid verify profile env');
  }

  const normalizedCwd = normalizeRunnerCwd(cwd);
  const normalizedExecutionRoot = normalizeExecutionRoot(executionRoot);
  const timeoutMs = Math.min(Math.max(profile.timeoutMs ?? 10_000, 100), 30_000);
  const maxOutputTokens = Math.min(Math.max(profile.maxOutputTokens ?? 4_000, 100), 10_000);
  const resumeQueuedAfterRestart = profile.resumeQueuedAfterRestart === true;
  const env = Object.fromEntries(envEntries);
  const command = buildVerifyCommand(
    profile.argv,
    envEntries,
    timeoutMs,
    normalizedCwd,
    normalizedExecutionRoot,
  );
  const canonical = JSON.stringify({
    argv: [...profile.argv],
    cwd: normalizedCwd,
    timeoutMs,
    maxOutputTokens,
    env: envEntries,
    resumeQueuedAfterRestart,
    ...(normalizedExecutionRoot === undefined ? {} : { executionRoot: normalizedExecutionRoot }),
  });
  const planSha256 = createHash('sha256').update(canonical, 'utf8').digest('hex');

  return {
    argv: [...profile.argv],
    env,
    cwd: normalizedCwd,
    ...(normalizedExecutionRoot === undefined ? {} : { executionRoot: normalizedExecutionRoot }),
    timeoutMs,
    maxOutputTokens,
    resumeQueuedAfterRestart,
    command,
    planSha256,
  };
}

function normalizeRunnerCwd(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (normalized === '.') return '.';
  if (normalized.length < 1 || normalized.length > 1024) throw new Error('Invalid command cwd');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error('Invalid command cwd');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('Invalid command cwd');
  }
  return normalized;
}

function normalizeExecutionRoot(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 4096 || value.includes('\0') || !isAbsolute(value)) {
    throw new Error('Invalid command execution root');
  }
  return value;
}
