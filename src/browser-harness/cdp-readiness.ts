import { resolveCdpWebSocketEndpoint } from './node-cdp-transport.js';

export async function waitForLoopbackCdpReady(options: {
  endpointUrl: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  fetchImpl?: Parameters<typeof resolveCdpWebSocketEndpoint>[0]['fetchImpl'];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 120_000) {
    throw new Error('CDP readiness timeout is invalid');
  }
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 5_000) {
    throw new Error('CDP readiness poll interval is invalid');
  }

  const deadline = now() + options.timeoutMs;
  let lastError: unknown;
  while (now() <= deadline) {
    try {
      return await resolveCdpWebSocketEndpoint({
        endpointUrl: options.endpointUrl,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        timeoutMs: Math.min(1_000, Math.max(100, deadline - now())),
      });
    } catch (error) {
      lastError = error;
    }
    if (now() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown');
  throw new Error(`CDP endpoint did not become ready: ${message}`);
}
