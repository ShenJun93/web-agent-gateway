const RUNTIME_ENV_KEYS = new Set([
  'path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'lang', 'lc_all',
]);
const DEVSPACE_ENV_KEYS = new Set(['DEVSPACE_CONFIG_DIR', 'DEVSPACE_OAUTH_OWNER_TOKEN']);

export function sanitizeDevspaceEnvironment(
  source: NodeJS.ProcessEnv,
  additions: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && RUNTIME_ENV_KEYS.has(key.toLowerCase())) result[key] = value;
  }
  for (const [key, value] of Object.entries(additions)) {
    if (!DEVSPACE_ENV_KEYS.has(key)) throw new Error(`Unsupported DevSpace supervisor environment key: ${key}`);
    result[key] = value;
  }
  return result;
}
