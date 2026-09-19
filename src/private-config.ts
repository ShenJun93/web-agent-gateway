import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { canonicalWorkspace } from './path-policy.js';

const verifyProfileSchema = z.object({
  argv: z.array(z.string().min(1).max(512)).min(1).max(16),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  maxOutputTokens: z.number().int().min(100).max(10_000).optional(),
}).strict();

export const DEFAULT_PRIVATE_STDIO_OWNER_ID = 'local.private.stdio';

const repositoryEngineeringSchema = z.object({
  inspect: z.boolean().default(false),
  mutation: z.object({
    statePath: z.string().min(1),
    ownerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).default(DEFAULT_PRIVATE_STDIO_OWNER_ID),
  }).strict().optional(),
}).strict();

const privateGatewayConfigSchema = z.object({
  allowedRoots: z.array(z.string().min(1)).min(1),
  devspace: z.object({
    baseUrl: z.string().url(),
    resourceUrl: z.string().url(),
  }).strict(),
  verifyProfiles: z.record(z.string().min(1), verifyProfileSchema),
  browserVerifyProfiles: z.array(
    z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  ).max(32).default([]),
  repositoryEngineering: repositoryEngineeringSchema.optional(),
}).strict();

export type PrivateVerifyProfile = z.infer<typeof verifyProfileSchema>;
export interface PrivateRepositoryEngineeringMutation {
  statePath: string;
  ownerId: string;
}
export interface PrivateRepositoryEngineering {
  inspect: boolean;
  mutation?: PrivateRepositoryEngineeringMutation;
}
export interface PrivateGatewayConfig {
  allowedRoots: string[];
  devspace: { baseUrl: string; resourceUrl: string };
  verifyProfiles: Record<string, PrivateVerifyProfile>;
  browserVerifyProfiles?: string[];
  repositoryEngineering?: PrivateRepositoryEngineering;
}
export async function loadPrivateGatewayConfig(configPath: string): Promise<PrivateGatewayConfig> {
  if (!isAbsolute(configPath)) throw new Error('Private gateway config path must be absolute');
  const parsed = privateGatewayConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const baseUrl = validateLoopbackBaseUrl(parsed.devspace.baseUrl);
  const resourceUrl = validateResourceUrl(parsed.devspace.resourceUrl, baseUrl);
  if (new Set(parsed.browserVerifyProfiles).size !== parsed.browserVerifyProfiles.length) {
    throw new Error('Private gateway browser verify profiles must be unique');
  }
  if (parsed.browserVerifyProfiles.some((name) => parsed.verifyProfiles[name] === undefined)) {
    throw new Error('Private gateway browser verify profile is not configured');
  }

  const mutation = parsed.repositoryEngineering?.mutation;
  if (mutation && !isAbsolute(mutation.statePath)) {
    throw new Error('Private gateway repository engineering mutation statePath must be absolute');
  }

  const allowedRoots: string[] = [];
  for (const configuredRoot of parsed.allowedRoots) {
    if (!isAbsolute(configuredRoot)) throw new Error('Private gateway allowed root must be absolute');
    const canonicalRoot = await realpath(configuredRoot);
    await canonicalWorkspace(canonicalRoot, [canonicalRoot]);
    allowedRoots.push(canonicalRoot);
  }

  return {
    allowedRoots,
    devspace: { baseUrl, resourceUrl },
    verifyProfiles: parsed.verifyProfiles,
    browserVerifyProfiles: parsed.browserVerifyProfiles,
    ...(parsed.repositoryEngineering === undefined ? {} : {
      repositoryEngineering: {
        inspect: parsed.repositoryEngineering.inspect,
        ...(mutation === undefined ? {} : { mutation: { statePath: mutation.statePath, ownerId: mutation.ownerId } }),
      },
    }),
  };
}

function validateLoopbackBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname.toLowerCase())) {
    throw new Error('Private gateway DevSpace baseUrl must use loopback');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Private gateway DevSpace baseUrl must use HTTP(S)');
  if (url.username || url.password || url.search || url.hash) throw new Error('Private gateway DevSpace baseUrl must not contain credentials, query, or fragment');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Private gateway DevSpace baseUrl must not contain a path');
  return url.origin;
}

function validateResourceUrl(value: string, baseUrl: string): string {
  const resource = new URL(value);
  if (resource.protocol !== 'http:' && resource.protocol !== 'https:') throw new Error('Private gateway DevSpace resourceUrl must use HTTP(S)');
  if (resource.origin !== new URL(baseUrl).origin) throw new Error('Private gateway DevSpace resourceUrl must use the configured DevSpace origin');
  if (resource.pathname !== '/mcp' || resource.search || resource.hash || resource.username || resource.password) {
    throw new Error('Private gateway DevSpace resourceUrl must identify the /mcp resource');
  }
  return resource.toString().replace(/\/$/, '');
}
