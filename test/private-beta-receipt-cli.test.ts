import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { aggregatePrivateBetaReceiptDirectory } from '../scripts/aggregate-private-beta-receipts.js';

function receipt(id: string) {
  return {
    schema: 'WAG_LOCAL_PRIVATE_BETA_RECEIPT_V1',
    installation_id: id,
    generated_at_utc: '2026-10-03T00:00:00.000Z',
    summary: {
      schema: 'WAG_LOCAL_PRIVATE_BETA_SUMMARY_V1',
      generated_at_utc: '2026-10-03T00:00:00.000Z',
      scope: {
        local_install_only: true,
        external_upload_performed: false,
        retained_event_window_only: true,
      },
      adoption_signals: {
        installed_release_observed: true,
        connector_confirmed: true,
        first_useful_workflow_completed: true,
        local_active_utc_days: 1,
        repeat_usage_signal_observed: true,
      },
      usage: {
        schema: 'WAG_LOCAL_BETA_USAGE_SUMMARY_V1',
        retained_events: 2,
        capacity: 512,
        window: {
          first_seen_at_utc: '2026-10-02T23:00:00.000Z',
          last_seen_at_utc: '2026-10-03T00:00:00.000Z',
          active_utc_days: 1,
        },
        totals: { calls: 2, successes: 2, failures: 0, success_rate: 1 },
        useful_workflow: { completed: true, successful_calls: 2 },
        repeat_usage_signal: {
          observed: true,
          repeated_tool_families: ['machine'],
          definition: 'TWO_OR_MORE_SUCCESSFUL_CALLS_IN_RETAINED_WINDOW',
        },
        tool_families: [{ family: 'machine', calls: 2, successes: 2, failures: 0 }],
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
    },
    privacy: {
      pseudonymous_install_id: true,
      user_identity_collected: false,
      machine_fingerprint_collected: false,
      automatic_upload_performed: false,
    },
  };
}

test('offline receipt directory aggregator reads bounded JSON and creates one private output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-beta-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'receipts');
  const output = join(root, 'aggregate.json');
  await mkdir(input);
  await writeFile(
    join(input, 'one.json'),
    JSON.stringify(receipt('beta_install_00000000-0000-4000-8000-000000000401')),
    'utf8',
  );
  await writeFile(
    join(input, 'two.json'),
    JSON.stringify(receipt('beta_install_00000000-0000-4000-8000-000000000402')),
    'utf8',
  );

  const aggregate = await aggregatePrivateBetaReceiptDirectory({
    inputDir: input,
    outputPath: output,
    asOfUtc: '2026-10-03T01:00:00.000Z',
  });
  assert.equal(aggregate.unique_installations, 2);
  const persisted = JSON.parse(await readFile(output, 'utf8')) as { schema: string; unique_installations: number };
  assert.equal(persisted.schema, 'WAG_PRIVATE_BETA_AGGREGATE_V1');
  assert.equal(persisted.unique_installations, 2);

  await assert.rejects(
    () => aggregatePrivateBetaReceiptDirectory({
      inputDir: input,
      outputPath: output,
      asOfUtc: '2026-10-03T01:00:00.000Z',
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
  );
});

test('offline receipt directory aggregator rejects relative paths and json-named non-files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-beta-cli-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => aggregatePrivateBetaReceiptDirectory({
      inputDir: 'relative',
      outputPath: join(root, 'out.json'),
    }),
    /MUST_BE_ABSOLUTE/,
  );

  const input = join(root, 'receipts');
  await mkdir(input);
  await mkdir(join(input, 'not-a-file.json'));
  await assert.rejects(
    () => aggregatePrivateBetaReceiptDirectory({
      inputDir: input,
      outputPath: join(root, 'out.json'),
      asOfUtc: '2026-10-03T01:00:00.000Z',
    }),
    /RECEIPT_FILE_INVALID/,
  );
});
