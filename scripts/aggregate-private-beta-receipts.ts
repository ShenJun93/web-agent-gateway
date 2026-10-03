import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  aggregatePrivateBetaReceipts,
  type PrivateBetaAggregate,
} from '../src/private-beta-receipt.js';

const MAX_RECEIPTS = 1_000;
const MAX_RECEIPT_BYTES = 1024 * 1024;

export interface AggregatePrivateBetaReceiptDirectoryOptions {
  inputDir: string;
  outputPath: string;
  asOfUtc?: string;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error('WAG_PRIVATE_BETA_' + label + '_MUST_BE_ABSOLUTE');
  return resolve(value);
}

export async function aggregatePrivateBetaReceiptDirectory(
  options: AggregatePrivateBetaReceiptDirectoryOptions,
): Promise<PrivateBetaAggregate> {
  const inputDir = absolutePath(options.inputDir, 'INPUT_DIR');
  const outputPath = absolutePath(options.outputPath, 'OUTPUT_PATH');

  const inputStat = await lstat(inputDir);
  if (inputStat.isSymbolicLink() || !inputStat.isDirectory()) {
    throw new Error('WAG_PRIVATE_BETA_INPUT_DIR_INVALID');
  }

  const entries = (await readdir(inputDir))
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort();
  if (entries.length < 1 || entries.length > MAX_RECEIPTS) {
    throw new Error('WAG_PRIVATE_BETA_RECEIPT_COUNT_INVALID');
  }

  const receipts: unknown[] = [];
  for (const name of entries) {
    const path = resolve(inputDir, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('WAG_PRIVATE_BETA_RECEIPT_FILE_INVALID');
    }
    if (stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) {
      throw new Error('WAG_PRIVATE_BETA_RECEIPT_FILE_SIZE_INVALID');
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('WAG_PRIVATE_BETA_RECEIPT_JSON_INVALID');
    }
    receipts.push(value);
  }

  const aggregate = aggregatePrivateBetaReceipts(receipts, {
    ...(options.asOfUtc === undefined ? {} : { asOfUtc: options.asOfUtc }),
  });

  await writeFile(outputPath, JSON.stringify(aggregate, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return aggregate;
}

function required(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error('Missing ' + name);
  return value;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const allowed = new Set(['--input-dir', '--output', '--as-of']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!allowed.has(arg)) throw new Error('Unknown argument: ' + arg);
    if (index + 1 >= argv.length || argv[index + 1]!.startsWith('--')) {
      throw new Error('Missing value for ' + arg);
    }
    index += 1;
  }

  const inputDir = required(argv, '--input-dir');
  const outputPath = required(argv, '--output');
  const asOfIndex = argv.indexOf('--as-of');
  const asOfUtc = asOfIndex >= 0 ? argv[asOfIndex + 1] : undefined;
  const aggregate = await aggregatePrivateBetaReceiptDirectory({
    inputDir,
    outputPath,
    ...(asOfUtc === undefined ? {} : { asOfUtc }),
  });

  process.stdout.write('WAG_PRIVATE_BETA_AGGREGATED=True\n');
  process.stdout.write('UNIQUE_INSTALLATIONS=' + aggregate.unique_installations + '\n');
  process.stdout.write('OUTPUT=' + outputPath + '\n');
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
      process.exitCode = 1;
    },
  );
}
