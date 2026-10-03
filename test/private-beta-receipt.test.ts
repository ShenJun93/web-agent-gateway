import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  aggregatePrivateBetaReceipts,
  createPrivateBetaReceipt,
  parsePrivateBetaReceipt,
  type PrivateBetaReceipt,
  type PrivateBetaSummary,
} from '../src/private-beta-receipt.js';

function summary(options: {
  installed?: boolean;
  connector?: boolean;
  useful?: boolean;
  repeat?: boolean;
  lastSeen?: string | null;
  calls?: number;
  successes?: number;
  family?: string;
  generatedAt?: string;
} = {}): PrivateBetaSummary {
  const calls = options.calls ?? 4;
  const successes = options.successes ?? 3;
  const failures = calls - successes;
  const useful = options.useful ?? true;
  const repeat = options.repeat ?? true;
  const lastSeen = options.lastSeen === undefined ? '2026-10-03T00:00:00.000Z' : options.lastSeen;
  const activeDays = lastSeen === null ? 0 : 1;
  const generatedAt = options.generatedAt
    ?? (lastSeen === null
      ? '2026-09-01T00:01:00.000Z'
      : new Date(Date.parse(lastSeen) + 60_000).toISOString());
  return {
    schema: 'WAG_LOCAL_PRIVATE_BETA_SUMMARY_V1',
    generated_at_utc: generatedAt,
    scope: {
      local_install_only: true,
      external_upload_performed: false,
      retained_event_window_only: true,
    },
    adoption_signals: {
      installed_release_observed: options.installed ?? true,
      connector_confirmed: options.connector ?? true,
      first_useful_workflow_completed: useful,
      local_active_utc_days: activeDays,
      repeat_usage_signal_observed: repeat,
    },
    usage: {
      schema: 'WAG_LOCAL_BETA_USAGE_SUMMARY_V1',
      retained_events: calls,
      capacity: 512,
      window: {
        first_seen_at_utc: lastSeen,
        last_seen_at_utc: lastSeen,
        active_utc_days: activeDays,
      },
      totals: {
        calls,
        successes,
        failures,
        success_rate: calls === 0 ? null : Math.round((successes / calls) * 10_000) / 10_000,
      },
      useful_workflow: {
        completed: useful,
        successful_calls: useful ? Math.min(successes, 2) : 0,
      },
      repeat_usage_signal: {
        observed: repeat,
        repeated_tool_families: repeat ? [options.family ?? 'browser'] : [],
        definition: 'TWO_OR_MORE_SUCCESSFUL_CALLS_IN_RETAINED_WINDOW',
      },
      tool_families: calls === 0 ? [] : [{
        family: options.family ?? 'browser',
        calls,
        successes,
        failures,
      }],
      privacy: {
        arguments_retained: false,
        paths_retained: false,
        contents_retained: false,
        owner_or_session_ids_retained: false,
        exception_messages_retained: false,
      },
    },
    not_collected: {
      external_user_count: 'NOT_COLLECTED',
      activation_rate: 'NOT_COLLECTED',
      first_useful_workflow_rate: 'NOT_COLLECTED',
      repeat_workflow_rate: 'NOT_COLLECTED',
      weekly_active_users: 'NOT_COLLECTED',
      retention_rate: 'NOT_COLLECTED',
      recovery_rate: 'NOT_COLLECTED',
      uninstall_reasons: 'NOT_COLLECTED',
      support_incidents: 'NOT_COLLECTED',
    },
    interpretation: {
      local_active_utc_days_is_not_wau: true,
      repeat_usage_signal_is_not_retention: true,
      aggregation_requires_explicit_receipt_collection: true,
    },
  };
}

test('private beta receipt requires consent and persists one stable random pseudonym', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-beta-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(
    () => createPrivateBetaReceipt({ installRoot: root, summary: summary(), consent: false }),
    /CONSENT_REQUIRED/,
  );

  const first = createPrivateBetaReceipt({
    installRoot: root,
    summary: summary(),
    consent: true,
    uuid: () => '00000000-0000-4000-8000-000000000111',
    now: () => new Date('2026-10-03T01:00:00.000Z'),
  });
  const second = createPrivateBetaReceipt({
    installRoot: root,
    summary: summary(),
    consent: true,
    uuid: () => '00000000-0000-4000-8000-000000000999',
    now: () => new Date('2026-10-03T02:00:00.000Z'),
  });

  assert.equal(first.installation_id, 'beta_install_00000000-0000-4000-8000-000000000111');
  assert.equal(second.installation_id, first.installation_id);
  assert.equal(
    (await readFile(join(root, 'state', 'private-beta-installation-id'), 'utf8')).trim(),
    first.installation_id,
  );
  assert.deepEqual(first.privacy, {
    pseudonymous_install_id: true,
    user_identity_collected: false,
    machine_fingerprint_collected: false,
    automatic_upload_performed: false,
  });
});

test('offline beta aggregation deduplicates installations and reports installation rates without claiming WAU or retention', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-beta-aggregate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootOne = join(root, 'one');
  const rootTwo = join(root, 'two');

  const oneOld = createPrivateBetaReceipt({
    installRoot: rootOne,
    summary: summary({ calls: 2, successes: 2, family: 'machine', lastSeen: '2026-09-20T00:00:00.000Z' }),
    consent: true,
    uuid: () => '00000000-0000-4000-8000-000000000201',
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  });
  const oneNew: PrivateBetaReceipt = {
    ...oneOld,
    generated_at_utc: '2026-10-03T00:00:00.000Z',
    summary: summary({ calls: 4, successes: 4, family: 'machine', lastSeen: '2026-10-02T12:00:00.000Z' }),
  };
  const two = createPrivateBetaReceipt({
    installRoot: rootTwo,
    summary: summary({
      installed: false,
      connector: false,
      useful: false,
      repeat: false,
      calls: 2,
      successes: 1,
      family: 'browser',
      lastSeen: '2026-09-01T00:00:00.000Z',
    }),
    consent: true,
    uuid: () => '00000000-0000-4000-8000-000000000202',
    now: () => new Date('2026-10-03T00:10:00.000Z'),
  });

  const aggregate = aggregatePrivateBetaReceipts([oneOld, oneNew, two], {
    asOfUtc: '2026-10-03T01:00:00.000Z',
  });
  assert.equal(aggregate.receipts_received, 3);
  assert.equal(aggregate.unique_installations, 2);
  assert.equal(aggregate.duplicate_receipts_ignored, 1);
  assert.deepEqual(aggregate.metrics, {
    installed_release_observed: 1,
    installed_release_rate: 0.5,
    connector_confirmed: 1,
    activation_rate: 0.5,
    useful_workflow_completed: 1,
    first_useful_workflow_rate: 0.5,
    repeat_usage_observed: 1,
    repeat_workflow_rate: 0.5,
    active_installations_7d: 1,
    active_installation_rate_7d: 0.5,
    calls: 6,
    successes: 5,
    failures: 1,
    success_rate: 0.8333,
  });
  assert.deepEqual(
    aggregate.tool_families.map((entry) => [entry.family, entry.calls]),
    [['machine', 4], ['browser', 2]],
  );
  assert.equal(aggregate.not_measured.weekly_active_users, 'NOT_MEASURED');
  assert.equal(aggregate.not_measured.retention_rate, 'NOT_MEASURED');
  assert.equal(aggregate.interpretation.unit_is_anonymous_installation_not_user, true);
  assert.equal(aggregate.interpretation.active_installations_7d_is_not_wau, true);
  assert.equal(aggregate.interpretation.repeat_workflow_rate_is_not_retention, true);
  assert.equal(aggregate.interpretation.receipts_are_self_reported_not_attested, true);
});

test('receipt validation rejects extra identity fields, conflicts, and implausible future receipts', () => {
  const base: PrivateBetaReceipt = {
    schema: 'WAG_LOCAL_PRIVATE_BETA_RECEIPT_V1',
    installation_id: 'beta_install_00000000-0000-4000-8000-000000000301',
    generated_at_utc: '2026-10-03T00:10:00.000Z',
    summary: summary(),
    privacy: {
      pseudonymous_install_id: true,
      user_identity_collected: false,
      machine_fingerprint_collected: false,
      automatic_upload_performed: false,
    },
  };

  assert.throws(() => parsePrivateBetaReceipt({ ...base, username: 'alice' }));

  const conflict: PrivateBetaReceipt = {
    ...base,
    summary: summary({ calls: 5, successes: 5 }),
  };
  assert.throws(
    () => aggregatePrivateBetaReceipts([base, conflict], { asOfUtc: '2026-10-03T01:00:00.000Z' }),
    /CONFLICT/,
  );

  assert.throws(
    () => aggregatePrivateBetaReceipts([
      { ...base, generated_at_utc: '2026-10-04T00:00:00.000Z' },
    ], { asOfUtc: '2026-10-03T01:00:00.000Z' }),
    /FROM_FUTURE/,
  );
});
