import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const setupPath = join(root, 'scripts', 'wag-local-setup.ps1');
const provisionPath = join(root, 'scripts', 'wag-local-provision.ps1');
const setup = readFileSync(setupPath, 'utf8');
const provision = readFileSync(provisionPath, 'utf8');

test('packaged runtime lock stays synchronized with the project lock', () => {
  assert.equal(
    readFileSync(join(root, 'packaging', 'runtime-package-lock.json'), 'utf8'),
    readFileSync(join(root, 'package-lock.json'), 'utf8'),
  );
});

test('setup bootstrap is per-user, supports read-only preflight, and never accepts CLI secrets', () => {
  assert.match(setup, /\[switch\]\$CheckOnly/);
  assert.match(setup, /LOCALAPPDATA/);
  assert.match(setup, /WAG_LOCAL_SETUP_V1/);
  assert.match(setup, /READY_TO_INSTALL/);
  assert.match(setup, /ACTION_REQUIRED/);
  assert.match(setup, /WAG_SETUP_CLIENT_PROFILE_REQUIRED/);
  assert.match(setup, /WAG_SETUP_TUNNEL_CLIENT_REQUIRED/);
  assert.match(setup, /WAG_SETUP_PROFILE_FILE/);
  assert.match(setup, /absolute WSL path without traversal/);
  assert.match(setup, /Invoke-Wsl @\('-e','cat',\$profileFileOverride\)/);
  assert.match(setup, /ConvertFrom-SecureString/);
  assert.match(setup, /npm\.cmd ci --omit=dev --ignore-scripts/);
  assert.match(setup, /rev-parse --show-toplevel/);
  assert.match(setup, /OrdinalIgnoreCase/);
  assert.doesNotMatch(setup, /HKLM|schtasks|Register-ScheduledTask/i);
  assert.doesNotMatch(setup, /\[string\]\$(?:ApiKey|Secret|Token)\b/i);
});

test('setup consumes a verified RELEASE manifest, seeds release state, and refuses bypass updates', () => {
  assert.match(setup, /RELEASE\.json/);
  assert.match(setup, /dist\\product-release\.js/);
  assert.match(setup, /hashReleasePayload/);
  assert.match(setup, /Packaged release payload hash does not match RELEASE\.json/);
  assert.match(setup, /WAG_LOCAL_RELEASE_STATE_V1/);
  assert.match(setup, /activeReleaseId = \$runtimeTag/);
  assert.match(setup, /previousReleaseId = \$null/);
  assert.match(setup, /channel = \$releaseChannel/);
  assert.match(setup, /migrationVersion = \$releaseMigrationVersion/);
  assert.match(setup, /releaseChannel = \$releaseChannel/);
  assert.match(setup, /releaseProvenance = \$releaseProvenance/);
  assert.match(setup, /use the supported update command instead of setup/);
});

test('setup generates a narrow per-user runtime/config and does not enable remote push by default', () => {
  assert.match(setup, /\$installOptions\.NoAutostart = \$true/);
  assert.match(setup, /\$installOptions\.NoStart = \$true/);
  assert.doesNotMatch(setup, /\$installArgs \+= '-No(?:Auto)?start'/i);
  assert.match(setup, /WAG-Workspace/);
  assert.match(setup, /runtime/);
  assert.match(setup, /wag-local\.config\.json/);
  assert.match(setup, /local\.private\.stdio/);
  assert.match(setup, /protectedBranches = @\('main','master'\)/);
  assert.doesNotMatch(setup, /remoteGitPush\s*=/);
});

test('packaged product health wrapper runs compiled code without dev tooling', () => {
  const health = readFileSync(join(root, 'scripts', 'wag-local-product-health.ps1'), 'utf8');
  assert.match(health, /dist\\product-health\.js/);
  assert.match(health, /node\.exe/);
  assert.doesNotMatch(health, /npx|tsx/i);
});

test('setup owns the generic tunnel client pin and wrapper migration path', () => {
  assert.match(setup, /tunnel-client-path\.txt/);
  assert.match(setup, /WAG_TUNNEL_CLIENT_PATH/);
  assert.match(setup, /\$HOME\/tools\/openai-tunnel-client\/v0\.0\.14\/tunnel-client/);
  assert.match(setup, /web-agent-gateway\.yaml/);
  assert.match(setup, /base64 -d/);
});

test('first-time provisioning wizard is bounded and never accepts persistent admin credentials', () => {
  assert.match(provision, /ACTION_REQUIRED_TUNNEL/);
  assert.match(provision, /ACTION_REQUIRED_RUNTIME_KEY/);
  assert.match(provision, /ACTION_REQUIRED_CHATGPT_CONNECTOR/);
  assert.match(provision, /'READY'/);
  assert.match(provision, /WAG_LOCAL_PROVISION_V1/);
  assert.match(provision, /WAG_SETUP_RUNTIME_API_KEY/);
  assert.match(provision, /Read-Host .* -AsSecureString/);
  assert.match(provision, /ConvertFrom-SecureString/);
  assert.match(provision, /sample_mcp_stdio_local/);
  assert.match(provision, /--control-plane-api-key-ref \$RuntimeKeyRef/);
  assert.match(provision, /chatgpt-connector\.confirmed/);
  assert.doesNotMatch(provision, /\[string\]\$(?:ApiKey|AdminKey|Secret|Token)\b/i);
  assert.doesNotMatch(provision, /OPENAI_ADMIN_KEY/);
});
