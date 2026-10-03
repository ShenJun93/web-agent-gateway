import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const INSTALLATION_ID = /^beta_install_[0-9a-f-]{36}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INSTALLATION_ID_FILE = 'private-beta-installation-id';
const NOT_COLLECTED = z.literal('NOT_COLLECTED');

function validIsoUtc(value: string): boolean {
  if (!ISO_UTC.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

const isoUtc = z.string().refine(validIsoUtc, 'invalid UTC timestamp');

const toolFamilySchema = z.object({
  family: z.string().min(1).max(64),
  calls: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.successes + value.failures !== value.calls) {
    ctx.addIssue({ code: 'custom', message: 'tool family totals do not reconcile' });
  }
});

export const privateBetaUsageSummarySchema = z.object({
  schema: z.literal('WAG_LOCAL_BETA_USAGE_SUMMARY_V1'),
  retained_events: z.number().int().nonnegative(),
  capacity: z.number().int().min(16).max(10_000),
  window: z.object({
    first_seen_at_utc: isoUtc.nullable(),
    last_seen_at_utc: isoUtc.nullable(),
    active_utc_days: z.number().int().nonnegative(),
  }).strict(),
  totals: z.object({
    calls: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    success_rate: z.number().min(0).max(1).nullable(),
  }).strict(),
  useful_workflow: z.object({
    completed: z.boolean(),
    successful_calls: z.number().int().nonnegative(),
  }).strict(),
  repeat_usage_signal: z.object({
    observed: z.boolean(),
    repeated_tool_families: z.array(z.string().min(1).max(64)).max(32),
    definition: z.literal('TWO_OR_MORE_SUCCESSFUL_CALLS_IN_RETAINED_WINDOW'),
  }).strict(),
  tool_families: z.array(toolFamilySchema).max(64),
  privacy: z.object({
    arguments_retained: z.literal(false),
    paths_retained: z.literal(false),
    contents_retained: z.literal(false),
    owner_or_session_ids_retained: z.literal(false),
    exception_messages_retained: z.literal(false),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.retained_events > value.capacity) {
    ctx.addIssue({ code: 'custom', message: 'retained events exceed capacity' });
  }
  if (value.totals.calls !== value.retained_events
      || value.totals.successes + value.totals.failures !== value.totals.calls) {
    ctx.addIssue({ code: 'custom', message: 'usage totals do not reconcile' });
  }
  if ((value.totals.calls === 0) !== (value.totals.success_rate === null)) {
    ctx.addIssue({ code: 'custom', message: 'usage success rate nullability is invalid' });
  }
  if (value.totals.calls > 0
      && value.totals.success_rate !== roundRate(value.totals.successes / value.totals.calls)) {
    ctx.addIssue({ code: 'custom', message: 'usage success rate does not reconcile' });
  }
  const familyCalls = value.tool_families.reduce((sum, entry) => sum + entry.calls, 0);
  const familySuccesses = value.tool_families.reduce((sum, entry) => sum + entry.successes, 0);
  const familyFailures = value.tool_families.reduce((sum, entry) => sum + entry.failures, 0);
  if (familyCalls !== value.totals.calls
      || familySuccesses !== value.totals.successes
      || familyFailures !== value.totals.failures) {
    ctx.addIssue({ code: 'custom', message: 'tool family totals do not reconcile with usage totals' });
  }
  if (value.useful_workflow.successful_calls > value.totals.successes
      || value.useful_workflow.completed !== (value.useful_workflow.successful_calls > 0)) {
    ctx.addIssue({ code: 'custom', message: 'useful workflow signal does not reconcile with successes' });
  }
  const repeated = new Set(value.repeat_usage_signal.repeated_tool_families);
  if (repeated.size !== value.repeat_usage_signal.repeated_tool_families.length
      || value.repeat_usage_signal.observed !== (repeated.size > 0)) {
    ctx.addIssue({ code: 'custom', message: 'repeat usage family signal is invalid' });
  }
  for (const family of repeated) {
    const entry = value.tool_families.find((candidate) => candidate.family === family);
    if (!entry || entry.successes < 2) {
      ctx.addIssue({ code: 'custom', message: 'repeat usage family lacks repeated success evidence' });
    }
  }
  const first = value.window.first_seen_at_utc;
  const last = value.window.last_seen_at_utc;
  if ((first === null) !== (last === null)) {
    ctx.addIssue({ code: 'custom', message: 'usage window bounds are incomplete' });
  }
  if (value.totals.calls === 0 && (first !== null || value.window.active_utc_days !== 0)) {
    ctx.addIssue({ code: 'custom', message: 'empty usage must have an empty activity window' });
  }
  if (value.totals.calls > 0 && (first === null || last === null || value.window.active_utc_days < 1)) {
    ctx.addIssue({ code: 'custom', message: 'non-empty usage requires an activity window' });
  }
  if (first !== null && last !== null && Date.parse(first) > Date.parse(last)) {
    ctx.addIssue({ code: 'custom', message: 'usage window is reversed' });
  }
});

export const privateBetaSummarySchema = z.object({
  schema: z.literal('WAG_LOCAL_PRIVATE_BETA_SUMMARY_V1'),
  generated_at_utc: isoUtc,
  scope: z.object({
    local_install_only: z.literal(true),
    external_upload_performed: z.literal(false),
    retained_event_window_only: z.literal(true),
  }).strict(),
  adoption_signals: z.object({
    installed_release_observed: z.boolean(),
    connector_confirmed: z.boolean(),
    first_useful_workflow_completed: z.boolean(),
    local_active_utc_days: z.number().int().nonnegative(),
    repeat_usage_signal_observed: z.boolean(),
  }).strict(),
  usage: privateBetaUsageSummarySchema,
  not_collected: z.object({
    external_user_count: NOT_COLLECTED,
    activation_rate: NOT_COLLECTED,
    first_useful_workflow_rate: NOT_COLLECTED,
    repeat_workflow_rate: NOT_COLLECTED,
    weekly_active_users: NOT_COLLECTED,
    retention_rate: NOT_COLLECTED,
    recovery_rate: NOT_COLLECTED,
    uninstall_reasons: NOT_COLLECTED,
    support_incidents: NOT_COLLECTED,
  }).strict(),
  interpretation: z.object({
    local_active_utc_days_is_not_wau: z.literal(true),
    repeat_usage_signal_is_not_retention: z.literal(true),
    aggregation_requires_explicit_receipt_collection: z.literal(true),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.adoption_signals.local_active_utc_days !== value.usage.window.active_utc_days) {
    ctx.addIssue({ code: 'custom', message: 'active UTC days do not reconcile' });
  }
  if (value.adoption_signals.first_useful_workflow_completed !== value.usage.useful_workflow.completed) {
    ctx.addIssue({ code: 'custom', message: 'useful workflow signal does not reconcile' });
  }
  if (value.adoption_signals.repeat_usage_signal_observed !== value.usage.repeat_usage_signal.observed) {
    ctx.addIssue({ code: 'custom', message: 'repeat usage signal does not reconcile' });
  }
  const last = value.usage.window.last_seen_at_utc;
  if (last !== null && Date.parse(last) > Date.parse(value.generated_at_utc)) {
    ctx.addIssue({ code: 'custom', message: 'summary predates its latest usage event' });
  }
});

export const privateBetaReceiptSchema = z.object({
  schema: z.literal('WAG_LOCAL_PRIVATE_BETA_RECEIPT_V1'),
  installation_id: z.string().regex(INSTALLATION_ID),
  generated_at_utc: isoUtc,
  summary: privateBetaSummarySchema,
  privacy: z.object({
    pseudonymous_install_id: z.literal(true),
    user_identity_collected: z.literal(false),
    machine_fingerprint_collected: z.literal(false),
    automatic_upload_performed: z.literal(false),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.summary.generated_at_utc) > Date.parse(value.generated_at_utc)) {
    ctx.addIssue({ code: 'custom', message: 'receipt predates its summary' });
  }
});

export type PrivateBetaSummary = z.infer<typeof privateBetaSummarySchema>;
export type PrivateBetaReceipt = z.infer<typeof privateBetaReceiptSchema>;

export interface PrivateBetaAggregate {
  schema: 'WAG_PRIVATE_BETA_AGGREGATE_V1';
  generated_at_utc: string;
  receipts_received: number;
  unique_installations: number;
  duplicate_receipts_ignored: number;
  metrics: {
    installed_release_observed: number;
    installed_release_rate: number;
    connector_confirmed: number;
    activation_rate: number;
    useful_workflow_completed: number;
    first_useful_workflow_rate: number;
    repeat_usage_observed: number;
    repeat_workflow_rate: number;
    active_installations_7d: number;
    active_installation_rate_7d: number;
    calls: number;
    successes: number;
    failures: number;
    success_rate: number | null;
  };
  tool_families: Array<{
    family: string;
    calls: number;
    successes: number;
    failures: number;
  }>;
  not_measured: {
    weekly_active_users: 'NOT_MEASURED';
    retention_rate: 'NOT_MEASURED';
    recovery_rate: 'NOT_MEASURED';
    uninstall_reasons: 'NOT_MEASURED';
    support_incidents: 'NOT_MEASURED';
  };
  interpretation: {
    unit_is_anonymous_installation_not_user: true;
    active_installations_7d_is_not_wau: true;
    repeat_workflow_rate_is_not_retention: true;
    latest_receipt_per_installation_only: true;
    receipts_are_self_reported_not_attested: true;
  };
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function readInstallationId(path: string): string {
  const value = readFileSync(path, 'utf8').trim();
  if (!INSTALLATION_ID.test(value)) throw new Error('WAG_PRIVATE_BETA_INSTALLATION_ID_INVALID');
  return value;
}

function loadOrCreateInstallationId(
  installRoot: string,
  uuid: () => string,
): string {
  const stateDir = join(installRoot, 'state');
  const path = join(stateDir, INSTALLATION_ID_FILE);
  if (existsSync(path)) return readInstallationId(path);
  mkdirSync(stateDir, { recursive: true });
  const value = 'beta_install_' + uuid();
  if (!INSTALLATION_ID.test(value)) throw new Error('WAG_PRIVATE_BETA_INSTALLATION_ID_INVALID');
  try {
    writeFileSync(path, value + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return value;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code === 'EEXIST') return readInstallationId(path);
    throw error;
  }
}

export function parsePrivateBetaSummary(value: unknown): PrivateBetaSummary {
  return privateBetaSummarySchema.parse(value);
}

export function parsePrivateBetaReceipt(value: unknown): PrivateBetaReceipt {
  return privateBetaReceiptSchema.parse(value);
}

export function createPrivateBetaReceipt(options: {
  installRoot: string;
  summary: unknown;
  consent: boolean;
  now?: () => Date;
  uuid?: () => string;
}): PrivateBetaReceipt {
  if (options.consent !== true) throw new Error('WAG_PRIVATE_BETA_RECEIPT_CONSENT_REQUIRED');
  const summary = parsePrivateBetaSummary(options.summary);
  const installationId = loadOrCreateInstallationId(
    options.installRoot,
    options.uuid ?? randomUUID,
  );
  const generatedAtUtc = (options.now ?? (() => new Date()))().toISOString();
  const receipt: PrivateBetaReceipt = {
    schema: 'WAG_LOCAL_PRIVATE_BETA_RECEIPT_V1',
    installation_id: installationId,
    generated_at_utc: generatedAtUtc,
    summary,
    privacy: {
      pseudonymous_install_id: true,
      user_identity_collected: false,
      machine_fingerprint_collected: false,
      automatic_upload_performed: false,
    },
  };
  return parsePrivateBetaReceipt(receipt);
}

export function aggregatePrivateBetaReceipts(
  values: readonly unknown[],
  options: { asOfUtc?: string } = {},
): PrivateBetaAggregate {
  if (values.length < 1 || values.length > 10_000) {
    throw new Error('WAG_PRIVATE_BETA_RECEIPT_COUNT_INVALID');
  }
  const asOfUtc = options.asOfUtc ?? new Date().toISOString();
  if (!validIsoUtc(asOfUtc)) throw new Error('WAG_PRIVATE_BETA_AS_OF_INVALID');
  const asOfMs = Date.parse(asOfUtc);
  const futureLimitMs = asOfMs + 5 * 60_000;
  const receipts = values.map(parsePrivateBetaReceipt);
  const latest = new Map<string, PrivateBetaReceipt>();

  for (const receipt of receipts) {
    const generatedMs = Date.parse(receipt.generated_at_utc);
    if (generatedMs > futureLimitMs) throw new Error('WAG_PRIVATE_BETA_RECEIPT_FROM_FUTURE');
    const current = latest.get(receipt.installation_id);
    if (!current) {
      latest.set(receipt.installation_id, receipt);
      continue;
    }
    const currentMs = Date.parse(current.generated_at_utc);
    if (generatedMs === currentMs) {
      if (JSON.stringify(receipt) !== JSON.stringify(current)) {
        throw new Error('WAG_PRIVATE_BETA_RECEIPT_CONFLICT');
      }
      continue;
    }
    if (generatedMs > currentMs) latest.set(receipt.installation_id, receipt);
  }

  const selected = [...latest.values()];
  const total = selected.length;
  const count = (predicate: (receipt: PrivateBetaReceipt) => boolean) =>
    selected.filter(predicate).length;
  const installed = count((receipt) => receipt.summary.adoption_signals.installed_release_observed);
  const activated = count((receipt) => receipt.summary.adoption_signals.connector_confirmed);
  const useful = count((receipt) => receipt.summary.adoption_signals.first_useful_workflow_completed);
  const repeated = count((receipt) => receipt.summary.adoption_signals.repeat_usage_signal_observed);
  const activeThresholdMs = asOfMs - 7 * 24 * 60 * 60 * 1000;
  const active7d = count((receipt) => {
    const last = receipt.summary.usage.window.last_seen_at_utc;
    if (last === null) return false;
    const time = Date.parse(last);
    return time >= activeThresholdMs && time <= futureLimitMs;
  });

  let calls = 0;
  let successes = 0;
  let failures = 0;
  const families = new Map<string, { calls: number; successes: number; failures: number }>();
  for (const receipt of selected) {
    calls += receipt.summary.usage.totals.calls;
    successes += receipt.summary.usage.totals.successes;
    failures += receipt.summary.usage.totals.failures;
    for (const family of receipt.summary.usage.tool_families) {
      const current = families.get(family.family) ?? { calls: 0, successes: 0, failures: 0 };
      current.calls += family.calls;
      current.successes += family.successes;
      current.failures += family.failures;
      families.set(family.family, current);
    }
  }

  return {
    schema: 'WAG_PRIVATE_BETA_AGGREGATE_V1',
    generated_at_utc: asOfUtc,
    receipts_received: receipts.length,
    unique_installations: total,
    duplicate_receipts_ignored: receipts.length - total,
    metrics: {
      installed_release_observed: installed,
      installed_release_rate: roundRate(installed / total),
      connector_confirmed: activated,
      activation_rate: roundRate(activated / total),
      useful_workflow_completed: useful,
      first_useful_workflow_rate: roundRate(useful / total),
      repeat_usage_observed: repeated,
      repeat_workflow_rate: roundRate(repeated / total),
      active_installations_7d: active7d,
      active_installation_rate_7d: roundRate(active7d / total),
      calls,
      successes,
      failures,
      success_rate: calls === 0 ? null : roundRate(successes / calls),
    },
    tool_families: [...families.entries()]
      .map(([family, value]) => ({ family, ...value }))
      .sort((a, b) => b.calls - a.calls || a.family.localeCompare(b.family)),
    not_measured: {
      weekly_active_users: 'NOT_MEASURED',
      retention_rate: 'NOT_MEASURED',
      recovery_rate: 'NOT_MEASURED',
      uninstall_reasons: 'NOT_MEASURED',
      support_incidents: 'NOT_MEASURED',
    },
    interpretation: {
      unit_is_anonymous_installation_not_user: true,
      active_installations_7d_is_not_wau: true,
      repeat_workflow_rate_is_not_retention: true,
      latest_receipt_per_installation_only: true,
      receipts_are_self_reported_not_attested: true,
    },
  };
}
