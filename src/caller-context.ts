import { z } from 'zod';

const authorityId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const providerId = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/);
const conversationRef = z.string().refine((value) =>
  Buffer.byteLength(value, 'utf8') <= 512 && !/[\u0000-\u001F]/.test(value));

const correlationSchema = z.object({
  provider: providerId.optional(),
  clientId: authorityId.optional(),
  conversationRef: conversationRef.optional(),
}).strict();

const callerContextSchema = z.object({
  ownerId: authorityId,
  sessionId: authorityId,
  adapterId: authorityId,
  correlation: correlationSchema.optional(),
}).strict();

export interface GatewayCallerCorrelation {
  readonly provider?: string;
  readonly clientId?: string;
  readonly conversationRef?: string;
}

export interface GatewayCallerContext {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly correlation?: GatewayCallerCorrelation;
}

export type GatewayAuthority = Pick<GatewayCallerContext, 'ownerId' | 'sessionId' | 'adapterId'>;

export function createGatewayCallerContext(value: unknown): GatewayCallerContext {
  const parsed = callerContextSchema.parse(value);
  const correlation = parsed.correlation === undefined
    ? undefined
    : Object.freeze({ ...parsed.correlation });
  return Object.freeze({
    ownerId: parsed.ownerId,
    sessionId: parsed.sessionId,
    adapterId: parsed.adapterId,
    ...(correlation === undefined ? {} : { correlation }),
  });
}
