import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z } from 'zod';

export const NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION = 1 as const;
export const NATIVE_HOST_FILENAME = 'wag-native-host.exe' as const;
export const NATIVE_HOST_APPLICATION_NAME = 'com.openai.web_agent_gateway' as const;
export const BROWSER_ADAPTER_EXTENSION_ID = 'nnhhhppkpogkedpjnijeagcbfjaoogec' as const;
export const NATIVE_HOST_REQUIRED_GATES = [
  'typecheck',
  'build',
  'browser-adapter-protocol',
  'native-messaging-framing',
  'native-host-protocol',
  'native-host-manifest',
  'browser-extension-identity',
  'native-host-artifact',
] as const;

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const boundedText = z.string().min(1).max(256);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200);
const receiptSchema = z.object({
  schemaVersion: z.literal(NATIVE_HOST_DISTRIBUTION_SCHEMA_VERSION),
  repository,
  sourceSha: sha40,
  sourceRef: z.string().regex(/^refs\/[A-Za-z0-9._\/-]{1,240}$/),
  workflowRunId: z.string().regex(/^[1-9][0-9]{0,39}$/),
  runAttempt: z.number().int().positive().max(1_000_000),
  runner: z.object({
    os: z.literal('Windows'),
    arch: z.literal('X64'),
    imageOS: boundedText.optional(),
    imageVersion: boundedText.optional(),
  }).strict(),
  nodeVersion: z.literal('24.20.0'),
  packageLockSha256: sha256,
  artifact: z.object({
    filename: z.literal(NATIVE_HOST_FILENAME),
    sha256,
  }).strict(),
  nativeApplicationName: z.literal(NATIVE_HOST_APPLICATION_NAME),
  extensionId: z.literal(BROWSER_ADAPTER_EXTENSION_ID),
  verificationGates: z.tuple(NATIVE_HOST_REQUIRED_GATES.map((gate) => z.literal(gate)) as [
    z.ZodLiteral<string>,
    ...z.ZodLiteral<string>[],
  ]),
}).strict();

export type NativeHostBuildReceipt = z.infer<typeof receiptSchema>;

export function parseNativeHostBuildReceipt(value: unknown): NativeHostBuildReceipt {
  return receiptSchema.parse(value);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
