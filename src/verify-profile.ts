import { createHash } from 'node:crypto';

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
  command: string;
  planSha256: string;
}

const SAFE_ARG = /^[A-Za-z0-9_./:\\+=@-]{1,512}$/;
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ENV_KEY = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;
export function resolveVerifyProfile(profile: VerifyProfile): ResolvedVerifyProfile {
  if (profile.argv.length < 1 || profile.argv.length > 16) throw new Error('Invalid verify profile argv');
  if (!profile.argv.every((arg) => SAFE_ARG.test(arg))) throw new Error('Invalid verify profile argv');

  const envEntries = Object.entries(profile.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (envEntries.length > 16) throw new Error('Invalid verify profile env');
  if (envEntries.some(([key, value]) => !SAFE_ENV_KEY.test(key) || !SAFE_ARG.test(value) || SECRET_ENV_KEY.test(key))) {
    throw new Error('Invalid verify profile env');
  }

  const timeoutMs = Math.min(Math.max(profile.timeoutMs ?? 10_000, 100), 30_000);
  const maxOutputTokens = Math.min(Math.max(profile.maxOutputTokens ?? 4_000, 100), 10_000);
  const resumeQueuedAfterRestart = profile.resumeQueuedAfterRestart === true;
  const env = Object.fromEntries(envEntries);
  const command = buildVerifyCommand(profile.argv, envEntries);
  const canonical = JSON.stringify({
    argv: [...profile.argv], timeoutMs, maxOutputTokens, env: envEntries, resumeQueuedAfterRestart,
  });
  const planSha256 = createHash('sha256').update(canonical, 'utf8').digest('hex');

  return { argv: [...profile.argv], env, timeoutMs, maxOutputTokens, resumeQueuedAfterRestart, command, planSha256 };
}
function buildVerifyCommand(argv: readonly string[], envEntries: readonly (readonly [string, string])[]): string {
  const scrub = process.platform === 'win32' ? 'set "DEVSPACE_OAUTH_OWNER_TOKEN="' : 'unset DEVSPACE_OAUTH_OWNER_TOKEN';
  const profileEnv = process.platform === 'win32'
    ? envEntries.map(([key, value]) => 'set "' + key + '=' + value + '"').join(' && ')
    : envEntries.map(([key, value]) => key + '=' + value).join(' ');
  return [scrub, profileEnv, argv.join(' ')].filter(Boolean).join(process.platform === 'win32' ? ' && ' : ' ');
}
