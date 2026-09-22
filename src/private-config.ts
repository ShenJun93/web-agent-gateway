import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { OPERATOR_CORRELATION_PATTERN } from './adapter-admission.js';
import { canonicalWorkspace } from './path-policy.js';

const verifyProfileSchema = z.object({
  argv: z.array(z.string().min(1).max(512)).min(1).max(16),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  maxOutputTokens: z.number().int().min(100).max(10_000).optional(),
}).strict();

export const DEFAULT_PRIVATE_STDIO_OWNER_ID = 'local.private.stdio';

const repositoryEngineeringSchema = z.object({
  inspect: z.boolean().default(false),
  gitCommit: z.object({
    protectedBranches: z.array(z.string().min(1).max(256)).min(1).max(64).optional(),
  }).strict().optional(),
  mutation: z.object({
    statePath: z.string().min(1),
    ownerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).default(DEFAULT_PRIVATE_STDIO_OWNER_ID),
    /**
     * How long a proposal stays approvable. The default is one minute; the browser operator
     * profile needs longer because the operator switches windows between the two human
     * gestures. Five minutes is the ceiling the commit path already allows.
     */
    reviewTtlMs: z.number().int().min(1_000).max(5 * 60_000).optional(),
    /**
     * The Autonomous Goal Lease this runtime will honour (ADR-0028).
     *
     * Absent means autonomous admission is off and every effect needs a human on the operator's
     * Approve route, which is the default and the only behaviour before this field existed.
     * Naming a lease here does not create one or grant anything: the lease's own bindings,
     * expiry and revocation still decide, and a lease id that is not in the durable store is
     * refused rather than treated as unrestricted.
     */
    goalLeaseId: z.string().min(1).max(128).regex(/^lease_[A-Za-z0-9._:-]+$/).optional(),
    /**
     * The Goal UI Delegation this runtime will honour (ADR-0029).
     *
     * Same shape as `goalLeaseId` above, and for the same reason. Absent means delegated Run is
     * off and every proposal stays on the human path, which is the default and the only behaviour
     * before this field existed. Naming a delegation here does not create one or grant anything:
     * its own bindings, window, supersession and revocation still decide, and an id that is not in
     * the durable store is refused rather than treated as unrestricted.
     *
     * What naming *does* do is make the row live. A delegation that exists but is not named here
     * is inert — which is how issuance stays a human act even though a row is just a row.
     */
    goalUiDelegationId: z.string().min(1).max(128).regex(/^uidel_[A-Za-z0-9._:-]+$/).optional(),
    /**
     * The correlation that gives this surface a *stable* durable session (ADR-0017, ADR-0030).
     *
     * Absent — the default, and every deployment before this field existed — the session id is
     * minted fresh per process, exactly as ADR-0020 §5 describes. That is the right default for
     * an interactive local caller: no MCP client can read, resume or replay a record proposed by
     * a previous process.
     *
     * It is the wrong default for a Goal Lease. A lease admits only the sessions listed in its own
     * row, so a session that changes on every start can never be the session a lease was issued
     * for — which made autonomous admission unreachable on this surface rather than merely unused.
     * Naming a correlation here resolves the session through the same
     * `getOrCreateAdapterSession` path a browser adapter uses: the same string returns the same
     * durable session across restarts, so a lease issued for it keeps applying.
     *
     * Required shape is the strong one, for the reason `OPERATOR_CORRELATION_PATTERN` gives:
     * whoever can choose the string joins the session, and this surface can propose changes. It
     * is read from local configuration only — never from a tool argument, the transport, the
     * client's environment or repository text — so it is a human act, like naming a lease.
     * Because it selects which session a lease's bindings match, it must be treated as authority
     * configuration: an agent may read and report it, and must never write it.
     */
    sessionCorrelation: z.string().regex(OPERATOR_CORRELATION_PATTERN).optional(),
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
  reviewTtlMs?: number;
  goalLeaseId?: string;
  goalUiDelegationId?: string;
  sessionCorrelation?: string;
}
export interface PrivateRepositoryEngineeringGitCommit {
  protectedBranches?: string[];
}
export interface PrivateRepositoryEngineering {
  inspect: boolean;
  gitCommit?: PrivateRepositoryEngineeringGitCommit;
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
  // Commit review reuses the durable store, caller context and operator server that mutation builds.
  // Accepting it alone would advertise nothing and bind nothing, which reads as a working opt-in.
  if (parsed.repositoryEngineering?.gitCommit && !mutation) {
    throw new Error('Private gateway repository engineering gitCommit requires mutation');
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
        ...(parsed.repositoryEngineering.gitCommit === undefined ? {} : {
          gitCommit: {
            ...(parsed.repositoryEngineering.gitCommit.protectedBranches === undefined
              ? {}
              : { protectedBranches: parsed.repositoryEngineering.gitCommit.protectedBranches }),
          },
        }),
        ...(mutation === undefined ? {} : {
          mutation: {
            statePath: mutation.statePath,
            ownerId: mutation.ownerId,
            ...(mutation.reviewTtlMs === undefined ? {} : { reviewTtlMs: mutation.reviewTtlMs }),
            ...(mutation.goalLeaseId === undefined ? {} : { goalLeaseId: mutation.goalLeaseId }),
            ...(mutation.goalUiDelegationId === undefined
              ? {} : { goalUiDelegationId: mutation.goalUiDelegationId }),
            ...(mutation.sessionCorrelation === undefined
              ? {} : { sessionCorrelation: mutation.sessionCorrelation }),
          },
        }),
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
