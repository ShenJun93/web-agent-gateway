import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PrivateGatewayConfig } from '../src/private-config.js';
import { createProductMcpContext } from '../src/product-ux.js';
import { ToolUsageDiagnostics } from '../src/tool-usage-diagnostics.js';

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'wag-product-ux-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const configDir = join(base, 'config');
  const stateDir = join(base, 'state');
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const configPath = join(configDir, 'wag-local.config.json');
  await writeFile(configPath, '{}\n', 'utf8');
  const secretMarker = 'sb_publishable_SUPER_SECRET_MARKER_123456';
  const rootMarker = join(base, 'private-root');
  await mkdir(rootMarker, { recursive: true });

  const config: PrivateGatewayConfig = {
    allowedRoots: [rootMarker],
    devspace: {
      baseUrl: 'http://127.0.0.1:7677',
      resourceUrl: 'http://127.0.0.1:7677/mcp',
    },
    verifyProfiles: {
      unit: { argv: ['node', '--version'] },
    },
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath: join(base, 'state.sqlite'),
        ownerId: 'local.private.stdio',
        sessionCorrelation: 'session_11111111-2222-3333-4444-555555555555',
      },
      gitCommit: { protectedBranches: ['main'] },
      remoteGitPush: {
        autonomous: {
          allowedPushUrls: ['https://github.com/example/private.git'],
          allowedDestinationRefs: ['refs/heads/work/test'],
        },
      },
      browser: {
        edgeExecutablePath: join(base, 'edge.exe'),
        profileRoot: join(base, 'browser-profile'),
      },
      desktop: { enabled: true },
    },
    remoteRelayDevice: {
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: secretMarker,
      deviceId: 'device-test-1234',
      secretEnv: 'WAG_DEVICE_SECRET',
    },
  };

  const diagnostics = new ToolUsageDiagnostics({ capacity: 32 });
  return { base, configPath, stateDir, config, diagnostics, secretMarker, rootMarker };
}

test('product config read exposes only safe summaries and derives the installed channel', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.stateDir, 'release-state.json'), JSON.stringify({
    schema: 'WAG_LOCAL_RELEASE_STATE_V1',
    activeReleaseId: 'release-a',
    previousReleaseId: 'release-z',
    channel: 'development',
    migrationVersion: 1,
    updatedAtUtc: '2026-09-30T00:00:00.000Z',
  }, null, 2), 'utf8');

  const product = createProductMcpContext({
    configPath: f.configPath,
    config: f.config,
    diagnostics: f.diagnostics,
  });
  const value = product.configGet() as {
    settings: { update_channel: string; auto_check_updates: boolean };
    settings_present: boolean;
    settings_revision: string;
    capabilities: Record<string, unknown>;
    release: Record<string, unknown>;
  };

  assert.equal(value.settings.update_channel, 'development');
  assert.equal(value.settings.auto_check_updates, true);
  assert.equal(value.settings_present, false);
  assert.match(value.settings_revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(value.capabilities, {
    allowed_root_count: 1,
    verify_profile_count: 1,
    repository_inspection_enabled: true,
    mutation_enabled: true,
    git_commit_enabled: true,
    remote_git_push_enabled: true,
    browser_enabled: true,
    desktop_enabled: true,
    remote_relay_configured: true,
  });
  assert.equal(value.release.state, 'READY');
  assert.equal(value.release.active_release_id, 'release-a');

  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(f.rootMarker), false);
  assert.equal(serialized.includes(f.secretMarker), false);
  assert.equal(serialized.includes('WAG_DEVICE_SECRET'), false);
  assert.equal(serialized.includes('github.com/example/private.git'), false);
  assert.equal(serialized.includes(f.configPath), false);
});

test('safe product preferences use revision-CAS and never mutate authority config', async (t) => {
  const f = await fixture(t);
  const originalConfig = await readFile(f.configPath, 'utf8');
  const product = createProductMcpContext({
    configPath: f.configPath,
    config: f.config,
    diagnostics: f.diagnostics,
  });

  const first = product.configGet() as { settings_revision: string };
  const updated = product.configUpdate({
    expectedRevision: first.settings_revision,
    updateChannel: 'beta',
    autoCheckUpdates: false,
  }) as {
    updated: boolean;
    settings: { update_channel: string; auto_check_updates: boolean };
    previous_revision: string;
    settings_revision: string;
    authority_increased: boolean;
    restart_required: boolean;
  };

  assert.equal(updated.updated, true);
  assert.equal(updated.settings.update_channel, 'beta');
  assert.equal(updated.settings.auto_check_updates, false);
  assert.equal(updated.previous_revision, first.settings_revision);
  assert.notEqual(updated.settings_revision, first.settings_revision);
  assert.equal(updated.authority_increased, false);
  assert.equal(updated.restart_required, false);

  const second = product.configUpdate({
    expectedRevision: updated.settings_revision,
    updateChannel: 'stable',
  }) as { settings_revision: string; settings: { update_channel: string; auto_check_updates: boolean } };
  assert.equal(second.settings.update_channel, 'stable');
  assert.equal(second.settings.auto_check_updates, false);

  assert.throws(
    () => product.configUpdate({
      expectedRevision: first.settings_revision,
      updateChannel: 'development',
    }),
    /STALE_REVISION/,
  );

  const persisted = JSON.parse(await readFile(join(f.base, 'config', 'product-settings.json'), 'utf8'));
  assert.deepEqual(persisted, {
    schema: 'WAG_LOCAL_PRODUCT_SETTINGS_V1',
    updateChannel: 'stable',
    autoCheckUpdates: false,
  });
  assert.equal(await readFile(f.configPath, 'utf8'), originalConfig);
});

test('a cross-process settings lock fails closed and leaves the lock owner untouched', async (t) => {
  const f = await fixture(t);
  const lockPath = join(f.base, 'config', 'product-settings.json.lock');
  await writeFile(lockPath, '{"pid":99999}\n', 'utf8');
  const product = createProductMcpContext({
    configPath: f.configPath,
    config: f.config,
    diagnostics: f.diagnostics,
  });
  const current = product.configGet() as { settings_revision: string };
  assert.throws(
    () => product.configUpdate({ expectedRevision: current.settings_revision, updateChannel: 'beta' }),
    /WRITE_BUSY/,
  );
  assert.equal((await readFile(lockPath, 'utf8')).includes('99999'), true);
});

test('malformed product settings fail closed rather than being silently replaced', async (t) => {
  const f = await fixture(t);
  const settingsPath = join(f.base, 'config', 'product-settings.json');
  await writeFile(settingsPath, JSON.stringify({
    schema: 'WAG_LOCAL_PRODUCT_SETTINGS_V1',
    updateChannel: 'stable',
    autoCheckUpdates: true,
    authorityOverride: true,
  }), 'utf8');

  const product = createProductMcpContext({
    configPath: f.configPath,
    config: f.config,
    diagnostics: f.diagnostics,
  });
  assert.throws(() => product.configGet(), /SETTINGS_INVALID/);
  assert.equal((await readFile(settingsPath, 'utf8')).includes('authorityOverride'), true);
});

test('product activity and usage reuse sanitized bounded diagnostics and help performs no action', async (t) => {
  const f = await fixture(t);
  const product = createProductMcpContext({
    configPath: f.configPath,
    config: f.config,
    diagnostics: f.diagnostics,
  });

  const done = f.diagnostics.begin('machine.read');
  done(true);
  const failed = f.diagnostics.begin('machine.command.run');
  failed(false, new Error('secret-bearing-message-never-retained'));

  const recent = product.activityRecent({ limit: 10 }) as {
    events: Array<{ tool: string; success: boolean; error_class?: string }>;
    retained_events: number;
  };
  assert.equal(recent.retained_events, 2);
  assert.deepEqual(recent.events.map((event) => event.tool), ['machine.read', 'machine.command.run']);
  assert.equal(JSON.stringify(recent).includes('secret-bearing-message-never-retained'), false);

  const usage = product.usage() as { total_calls: number; successes: number; failures: number };
  assert.deepEqual(
    { total_calls: usage.total_calls, successes: usage.successes, failures: usage.failures },
    { total_calls: 2, successes: 1, failures: 1 },
  );

  const help = product.help() as { schema: string; workflows: Array<{ id: string }> };
  assert.equal(help.schema, 'WAG_LOCAL_PRODUCT_HELP_V1');
  assert.ok(help.workflows.some((entry) => entry.id === 'documents'));
  assert.ok(help.workflows.some((entry) => entry.id === 'lifecycle'));
});


test('private beta summary reports bounded local adoption signals without inventing user metrics', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.stateDir, 'release-state.json'), JSON.stringify({
    schema: 'WAG_LOCAL_RELEASE_STATE_V1',
    activeReleaseId: 'release-beta',
    previousReleaseId: null,
    channel: 'beta',
    migrationVersion: 1,
    updatedAtUtc: '2026-10-03T00:00:00.000Z',
  }, null, 2), 'utf8');
  await writeFile(join(f.stateDir, 'chatgpt-connector.confirmed'), 'confirmed\n', 'utf8');

  f.diagnostics.begin('machine.read')(true);
  f.diagnostics.begin('machine.read')(true);
  f.diagnostics.begin('product.usage')(true);

  const product = createProductMcpContext({
    configPath: f.configPath,
    config: f.config,
    diagnostics: f.diagnostics,
  });
  const summary = product.betaSummary() as {
    schema: string;
    scope: Record<string, boolean>;
    adoption_signals: Record<string, boolean | number>;
    usage: { repeat_usage_signal: { observed: boolean }; privacy: Record<string, boolean> };
    not_collected: Record<string, string>;
    interpretation: Record<string, boolean>;
  };

  assert.equal(summary.schema, 'WAG_LOCAL_PRIVATE_BETA_SUMMARY_V1');
  assert.deepEqual(summary.scope, {
    local_install_only: true,
    external_upload_performed: false,
    retained_event_window_only: true,
  });
  assert.equal(summary.adoption_signals.installed_release_observed, true);
  assert.equal(summary.adoption_signals.connector_confirmed, true);
  assert.equal(summary.adoption_signals.first_useful_workflow_completed, true);
  assert.equal(summary.adoption_signals.repeat_usage_signal_observed, true);
  assert.equal(summary.not_collected.activation_rate, 'NOT_COLLECTED');
  assert.equal(summary.not_collected.first_useful_workflow_rate, 'NOT_COLLECTED');
  assert.equal(summary.not_collected.repeat_workflow_rate, 'NOT_COLLECTED');
  assert.equal(summary.not_collected.weekly_active_users, 'NOT_COLLECTED');
  assert.equal(summary.not_collected.retention_rate, 'NOT_COLLECTED');
  assert.equal(summary.not_collected.uninstall_reasons, 'NOT_COLLECTED');
  assert.equal(summary.interpretation.local_active_utc_days_is_not_wau, true);
  assert.equal(summary.interpretation.repeat_usage_signal_is_not_retention, true);

  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(f.rootMarker), false);
  assert.equal(serialized.includes(f.secretMarker), false);
  assert.equal(serialized.includes('session_11111111-2222-3333-4444-555555555555'), false);
  assert.equal(serialized.includes('github.com/example/private.git'), false);
});
