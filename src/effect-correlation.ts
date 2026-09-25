export interface HarnessEffectCorrelation {
  readonly effectId: string;
  readonly attemptId?: string;
}

const EFFECT_ID = /^effect_[0-9a-f-]{36}$/;
const ATTEMPT_ID = /^attempt_[0-9a-f-]{36}$/;
const ERROR_CORRELATION = Symbol.for('wag.harness.effect-correlation');

function validCorrelation(value: unknown): HarnessEffectCorrelation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as { effectId?: unknown; attemptId?: unknown };
  if (typeof row.effectId !== 'string' || !EFFECT_ID.test(row.effectId)) return undefined;
  if (row.attemptId !== undefined
    && (typeof row.attemptId !== 'string' || !ATTEMPT_ID.test(row.attemptId))) {
    return undefined;
  }
  return Object.freeze({
    effectId: row.effectId,
    ...(row.attemptId === undefined ? {} : { attemptId: row.attemptId }),
  });
}

/**
 * Preserve exact-once effect identity across an executor throw without putting ids into the
 * human-facing error message. Diagnostics may recover the ids even if the MCP response stream is
 * lost after the local effect boundary.
 */
export function attachHarnessEffectCorrelation(
  error: unknown,
  correlation: HarnessEffectCorrelation,
): unknown {
  const safe = validCorrelation(correlation);
  if (!safe) return error;
  const target = error instanceof Error
    ? error
    : new Error('Harness effect executor threw a non-Error value', { cause: error });
  try {
    Object.defineProperty(target, ERROR_CORRELATION, {
      value: safe,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  } catch {
    // Correlation is recovery metadata only. Never replace the original business error merely
    // because an exotic Error object is non-extensible.
  }
  return target;
}

export function harnessEffectCorrelationFromError(error: unknown): HarnessEffectCorrelation | undefined {
  if (!(error instanceof Error)) return undefined;
  return validCorrelation((error as unknown as Record<PropertyKey, unknown>)[ERROR_CORRELATION]);
}

export function harnessEffectCorrelationFromToolResult(value: unknown): HarnessEffectCorrelation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const structured = (value as { structuredContent?: unknown }).structuredContent;
  return validCorrelation(structured);
}
