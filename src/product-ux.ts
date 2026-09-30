import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PrivateGatewayConfig } from './private-config.js';
import { checkProductUpdate } from './product-update-discovery.js';
import type { ToolUsageDiagnostics } from './tool-usage-diagnostics.js';

export type ProductUpdateChannel = 'stable' | 'beta' | 'development';

export interface ProductSettings {
  schema: 'WAG_LOCAL_PRODUCT_SETTINGS_V1';
  updateChannel: ProductUpdateChannel;
  autoCheckUpdates: boolean;
}

export interface ProductConfigUpdate {
  expectedRevision: string;
  updateChannel?: ProductUpdateChannel;
  autoCheckUpdates?: boolean;
}

export interface ProductMcpContext {
  configGet(): object;
  configUpdate(input: ProductConfigUpdate): object;
  activityRecent(options?: { limit?: number; afterSequence?: number }): object;
  usage(): object;
  updateCheck(): Promise<object>;
  help(): object;
}

export interface ProductUxOptions {
  configPath: string;
  config: PrivateGatewayConfig;
  diagnostics: ToolUsageDiagnostics;
}

const SETTINGS_FILE = 'product-settings.json';
const SETTINGS_SCHEMA = 'WAG_LOCAL_PRODUCT_SETTINGS_V1';
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalBytes(settings: ProductSettings): string {
  return JSON.stringify(settings, null, 2) + '\n';
}

function releaseChannelFromState(configPath: string): ProductUpdateChannel | null {
  const statePath = join(dirname(dirname(resolve(configPath))), 'state', 'release-state.json');
  if (!existsSync(statePath)) return null;
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8')) as {
      channel?: unknown;
    };
    return value.channel === 'stable' || value.channel === 'beta' || value.channel === 'development'
      ? value.channel
      : null;
  } catch {
    return null;
  }
}

function readReleaseSummary(configPath: string): object | null {
  const statePath = join(dirname(dirname(resolve(configPath))), 'state', 'release-state.json');
  if (!existsSync(statePath)) return null;
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8')) as {
      schema?: unknown;
      activeReleaseId?: unknown;
      previousReleaseId?: unknown;
      channel?: unknown;
      migrationVersion?: unknown;
      updatedAtUtc?: unknown;
    };
    if (value.schema !== 'WAG_LOCAL_RELEASE_STATE_V1'
        || typeof value.activeReleaseId !== 'string'
        || !(value.previousReleaseId === null || typeof value.previousReleaseId === 'string')
        || !['stable', 'beta', 'development'].includes(String(value.channel))
        || !Number.isInteger(value.migrationVersion)
        || typeof value.updatedAtUtc !== 'string') {
      return { state: 'INVALID' };
    }
    return {
      state: 'READY',
      active_release_id: value.activeReleaseId,
      previous_release_id: value.previousReleaseId,
      channel: value.channel,
      migration_version: value.migrationVersion,
      updated_at_utc: value.updatedAtUtc,
    };
  } catch {
    return { state: 'INVALID' };
  }
}

function defaultSettings(configPath: string): ProductSettings {
  return {
    schema: SETTINGS_SCHEMA,
    updateChannel: releaseChannelFromState(configPath) ?? 'stable',
    autoCheckUpdates: true,
  };
}

function parseSettings(raw: string): ProductSettings {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('WAG_PRODUCT_SETTINGS_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('WAG_PRODUCT_SETTINGS_INVALID');
  }
  const row = value as Partial<ProductSettings> & Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.join(',') !== ['autoCheckUpdates', 'schema', 'updateChannel'].sort().join(',')
      || row.schema !== SETTINGS_SCHEMA
      || !['stable', 'beta', 'development'].includes(String(row.updateChannel))
      || typeof row.autoCheckUpdates !== 'boolean') {
    throw new Error('WAG_PRODUCT_SETTINGS_INVALID');
  }
  return {
    schema: SETTINGS_SCHEMA,
    updateChannel: row.updateChannel as ProductUpdateChannel,
    autoCheckUpdates: row.autoCheckUpdates,
  };
}

function readSettings(settingsPath: string, fallback: ProductSettings): {
  present: boolean;
  settings: ProductSettings;
  revision: string;
} {
  if (!existsSync(settingsPath)) {
    const bytes = canonicalBytes(fallback);
    return {
      present: false,
      settings: fallback,
      revision: sha256('ABSENT\0' + bytes),
    };
  }
  const raw = readFileSync(settingsPath, 'utf8');
  return {
    present: true,
    settings: parseSettings(raw),
    revision: sha256(raw),
  };
}

function safeConfigSummary(config: PrivateGatewayConfig): object {
  return {
    allowed_root_count: config.allowedRoots.length,
    verify_profile_count: Object.keys(config.verifyProfiles).length,
    repository_inspection_enabled: config.repositoryEngineering?.inspect === true,
    mutation_enabled: config.repositoryEngineering?.mutation !== undefined,
    git_commit_enabled: config.repositoryEngineering?.gitCommit !== undefined,
    remote_git_push_enabled: config.repositoryEngineering?.remoteGitPush !== undefined,
    browser_enabled: config.repositoryEngineering?.browser !== undefined,
    desktop_enabled: config.repositoryEngineering?.desktop !== undefined,
    remote_relay_configured: config.remoteRelayDevice !== undefined,
  };
}

export function createProductMcpContext(options: ProductUxOptions): ProductMcpContext {
  const configPath = resolve(options.configPath);
  const settingsPath = join(dirname(configPath), SETTINGS_FILE);
  const installRoot = dirname(dirname(configPath));
  const lockPath = settingsPath + '.lock';
  const fallback = defaultSettings(configPath);
  const diagnostics = options.diagnostics;
  let writeInProgress = false;

  return {
    configGet() {
      const current = readSettings(settingsPath, fallback);
      return {
        schema: 'WAG_LOCAL_PRODUCT_CONFIG_V1',
        settings: {
          update_channel: current.settings.updateChannel,
          auto_check_updates: current.settings.autoCheckUpdates,
        },
        settings_present: current.present,
        settings_revision: current.revision,
        release: readReleaseSummary(configPath),
        capabilities: safeConfigSummary(options.config),
      };
    },

    configUpdate(input) {
      if (!SHA256.test(input.expectedRevision)) {
        throw new Error('WAG_PRODUCT_SETTINGS_REVISION_INVALID');
      }
      if (input.updateChannel === undefined && input.autoCheckUpdates === undefined) {
        throw new Error('WAG_PRODUCT_SETTINGS_NO_CHANGES');
      }
      if (writeInProgress) throw new Error('WAG_PRODUCT_SETTINGS_WRITE_BUSY');
      writeInProgress = true;
      const temp = settingsPath + '.tmp-' + randomUUID();
      let lockHeld = false;
      try {
        try {
          writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtUtc: new Date().toISOString() }) + '\n', {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
          });
          lockHeld = true;
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code)
            : '';
          if (code === 'EEXIST') throw new Error('WAG_PRODUCT_SETTINGS_WRITE_BUSY');
          throw error;
        }

        const before = readSettings(settingsPath, fallback);
        if (before.revision !== input.expectedRevision) {
          throw new Error('WAG_PRODUCT_SETTINGS_STALE_REVISION');
        }
        const next: ProductSettings = {
          schema: SETTINGS_SCHEMA,
          updateChannel: input.updateChannel ?? before.settings.updateChannel,
          autoCheckUpdates: input.autoCheckUpdates ?? before.settings.autoCheckUpdates,
        };
        const bytes = canonicalBytes(next);
        writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

        const revalidated = readSettings(settingsPath, fallback);
        if (revalidated.revision !== input.expectedRevision
            || revalidated.present !== before.present) {
          throw new Error('WAG_PRODUCT_SETTINGS_STALE_REVISION');
        }
        renameSync(temp, settingsPath);
        const after = readSettings(settingsPath, fallback);
        return {
          schema: 'WAG_LOCAL_PRODUCT_CONFIG_UPDATE_V1',
          updated: true,
          settings: {
            update_channel: after.settings.updateChannel,
            auto_check_updates: after.settings.autoCheckUpdates,
          },
          previous_revision: before.revision,
          settings_revision: after.revision,
          restart_required: false,
          authority_increased: false,
        };
      } finally {
        rmSync(temp, { force: true });
        if (lockHeld) rmSync(lockPath, { force: true });
        writeInProgress = false;
      }
    },

    activityRecent(options = {}) {
      return diagnostics.recent({
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
      });
    },

    usage() {
      return diagnostics.usage();
    },

    async updateCheck() {
      return checkProductUpdate({ installRoot, respectAutoCheck: false });
    },

    help() {
      return {
        schema: 'WAG_LOCAL_PRODUCT_HELP_V1',
        workflows: [
          { id: 'files', description: 'Read, inspect, create, edit, move and delete bounded local files with machine.* and file.* tools.' },
          { id: 'documents', description: 'Inspect/create/edit bounded DOCX, XLSX and PDF documents with machine document tools.' },
          { id: 'search', description: 'Run, continue, list and cancel bounded local search sessions.' },
          { id: 'terminal', description: 'Run bounded argv commands and manage WAG-owned process/terminal sessions.' },
          { id: 'repository', description: 'Inspect repositories, apply reviewed mutations, verify, commit and use bounded remote push.' },
          { id: 'browser', description: 'Use the BrowserPort surface when the local browser harness is configured.' },
          { id: 'diagnostics', description: 'Use product activity/usage plus wag doctor for product health and repair.' },
          { id: 'lifecycle', description: 'Check signed update metadata, then use explicit update/rollback/uninstall lifecycle commands for installed releases.' },
        ],
      };
    },
  };
}
