import { createHash } from 'node:crypto';
import type { GatewayAuthority } from '../caller-context.js';
import type { HarnessEffectRecord } from '../harness-effect-ledger.js';
import { HarnessEffectCoordinator } from '../harness-effect-coordinator.js';

export interface Notebook99Observation {
  readonly selectedSources: readonly string[];
}

export interface Notebook99ResultObservation {
  readonly responseText: string;
  readonly persistedTagCount: number;
}

export interface Notebook99Driver {
  inspect(owner: GatewayAuthority, browserSessionId: string): Promise<Notebook99Observation>;
  submit(owner: GatewayAuthority, browserSessionId: string, prompt: string): Promise<void>;
  observeResult(
    owner: GatewayAuthority,
    browserSessionId: string,
    promptTag: string,
  ): Promise<Notebook99ResultObservation>;
}

export interface Notebook99AcceptanceRequest {
  readonly browserSessionId: string;
  readonly idempotencyKey: string;
  readonly promptTag: string;
  readonly prompt: string;
  readonly expectedSources: readonly string[];
}

const TAG = /^[A-Za-z0-9._:-]{1,200}$/;
const SOURCE = /^[^\u0000-\u001F]{1,200}$/;
const MAX_PROMPT_BYTES = 128 * 1024;

function normalizeSources(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) {
    throw new Error('Notebook99 expected source set is invalid');
  }
  const unique = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string' || !SOURCE.test(item)) {
      throw new Error('Notebook99 source name is invalid');
    }
    if (unique.has(item)) throw new Error('Notebook99 expected source set contains duplicates');
    unique.add(item);
  }
  return Object.freeze([...unique].sort());
}

function exactSources(actual: readonly string[], expected: readonly string[]): boolean {
  const normalizedActual = [...new Set(actual)].sort();
  return normalizedActual.length === actual.length
    && normalizedActual.length === expected.length
    && normalizedActual.every((item, index) => item === expected[index]);
}

function resultDigest(
  promptTag: string,
  selectedSources: readonly string[],
  responseText: string,
): string {
  const hash = createHash('sha256');
  hash.update('WAG/notebook99-acceptance-result/v1\n', 'utf8');
  hash.update(promptTag, 'utf8');
  hash.update('\n', 'utf8');
  for (const source of selectedSources) {
    hash.update(source, 'utf8');
    hash.update('\n', 'utf8');
  }
  hash.update(responseText, 'utf8');
  return `sha256:${hash.digest('hex')}`;
}

export function createNotebook99Acceptance(options: {
  effects: HarnessEffectCoordinator;
  driver: Notebook99Driver;
}) {
  return {
    async run(
      owner: GatewayAuthority,
      request: Notebook99AcceptanceRequest,
    ): Promise<HarnessEffectRecord> {
      if (!TAG.test(request.idempotencyKey)) throw new Error('Notebook99 idempotency key is invalid');
      if (!TAG.test(request.promptTag)) throw new Error('Notebook99 prompt tag is invalid');
      if (typeof request.prompt !== 'string' || request.prompt.includes('\0')
          || Buffer.byteLength(request.prompt, 'utf8') < 1
          || Buffer.byteLength(request.prompt, 'utf8') > MAX_PROMPT_BYTES) {
        throw new Error('Notebook99 prompt is invalid');
      }
      const expectedSources = normalizeSources(request.expectedSources);
      const promptSha256 = createHash('sha256').update(request.prompt, 'utf8').digest('hex');

      return options.effects.execute(
        owner,
        request.idempotencyKey,
        {
          kind: 'browser.notebook99.submit',
          resourceId: `browser:${request.browserSessionId}:notebook99`,
          arguments: {
            promptTag: request.promptTag,
            promptSha256,
            expectedSources: [...expectedSources],
          },
        },
        async () => {
          let initial: Notebook99Observation;
          try {
            initial = await options.driver.inspect(owner, request.browserSessionId);
          } catch {
            return { status: 'NO_EFFECT', errorClass: 'NOTEBOOK_INSPECTION_FAILED' };
          }
          if (!exactSources(initial.selectedSources, expectedSources)) {
            return { status: 'NO_EFFECT', errorClass: 'NOTEBOOK_SOURCE_TOPOLOGY_MISMATCH' };
          }

          const submittedPrompt = `${request.prompt}\n\nIDEMPOTENCY_TAG=${request.promptTag}`;
          await options.driver.submit(owner, request.browserSessionId, submittedPrompt);

          let observed: Notebook99ResultObservation;
          try {
            observed = await options.driver.observeResult(
              owner,
              request.browserSessionId,
              request.promptTag,
            );
          } catch {
            return { status: 'OUTCOME_UNKNOWN', errorClass: 'NOTEBOOK_RESULT_OBSERVATION_FAILED' };
          }
          if (!Number.isInteger(observed.persistedTagCount) || observed.persistedTagCount < 0) {
            return { status: 'OUTCOME_UNKNOWN', errorClass: 'NOTEBOOK_PERSISTENCE_COUNT_INVALID' };
          }
          if (observed.persistedTagCount !== 1) {
            return {
              status: 'OUTCOME_UNKNOWN',
              errorClass: observed.persistedTagCount === 0
                ? 'NOTEBOOK_PERSISTENCE_NOT_OBSERVED'
                : 'NOTEBOOK_DUPLICATE_PERSISTENCE',
            };
          }
          if (typeof observed.responseText !== 'string' || observed.responseText.trim().length === 0) {
            return { status: 'OUTCOME_UNKNOWN', errorClass: 'NOTEBOOK_RESPONSE_NOT_OBSERVED' };
          }

          return {
            status: 'CONFIRMED_SUCCESS',
            resultDigest: resultDigest(
              request.promptTag,
              expectedSources,
              observed.responseText,
            ),
          };
        },
      );
    },
  };
}
