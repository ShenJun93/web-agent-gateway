import type { BrowserMcpSnapshot } from './browser-mcp-runtime.js';
import type { SemanticNode } from './semantic-browser.js';

export type BrowserSemanticTextOperator = 'equals' | 'contains';

export type BrowserSemanticCondition =
  | {
      readonly kind: 'url' | 'title';
      readonly operator: BrowserSemanticTextOperator;
      readonly value: string;
      readonly ignoreCase?: boolean;
    }
  | {
      readonly kind: 'node';
      readonly present?: boolean;
      readonly operator?: BrowserSemanticTextOperator;
      readonly role?: string;
      readonly name?: string;
      readonly value?: string;
      readonly disabled?: boolean;
      readonly editable?: boolean;
      readonly focusable?: boolean;
      readonly ignoreCase?: boolean;
    };

export interface BrowserSemanticConditionResult {
  readonly condition: BrowserSemanticCondition;
  readonly matched: boolean;
  readonly evidence?: {
    readonly ref?: string;
    readonly role?: string;
    readonly name?: string;
    readonly value?: string;
    readonly url?: string;
    readonly title?: string;
  };
}

export interface BrowserSemanticEvaluation {
  readonly matched: boolean;
  readonly mode: 'all' | 'any';
  readonly results: readonly BrowserSemanticConditionResult[];
}

function normalize(value: string, ignoreCase: boolean): string {
  return ignoreCase ? value.toLocaleLowerCase('en-US') : value;
}

function matchText(
  actual: string,
  expected: string,
  operator: BrowserSemanticTextOperator,
  ignoreCase: boolean,
): boolean {
  const left = normalize(actual, ignoreCase);
  const right = normalize(expected, ignoreCase);
  return operator === 'equals' ? left === right : left.includes(right);
}

function nodeMatches(node: SemanticNode, condition: Extract<BrowserSemanticCondition, { kind: 'node' }>): boolean {
  const operator = condition.operator ?? 'contains';
  const ignoreCase = condition.ignoreCase === true;
  if (condition.role !== undefined && !matchText(node.role, condition.role, operator, ignoreCase)) return false;
  if (condition.name !== undefined && !matchText(node.name, condition.name, operator, ignoreCase)) return false;
  if (condition.value !== undefined && !matchText(node.value ?? '', condition.value, operator, ignoreCase)) return false;
  if (condition.disabled !== undefined && node.disabled !== condition.disabled) return false;
  if (condition.editable !== undefined && node.editable !== condition.editable) return false;
  if (condition.focusable !== undefined && node.focusable !== condition.focusable) return false;
  return true;
}

function validateCondition(condition: BrowserSemanticCondition): void {
  if (condition.kind === 'node') {
    if (condition.role === undefined
        && condition.name === undefined
        && condition.value === undefined
        && condition.disabled === undefined
        && condition.editable === undefined
        && condition.focusable === undefined) {
      throw new Error('Browser semantic node condition requires at least one predicate');
    }
    return;
  }
  if (condition.value.length < 1) throw new Error('Browser semantic text condition is empty');
}

export function evaluateBrowserSemanticConditions(
  snapshot: BrowserMcpSnapshot,
  conditions: readonly BrowserSemanticCondition[],
  mode: 'all' | 'any' = 'all',
): BrowserSemanticEvaluation {
  if (!Array.isArray(conditions) || conditions.length < 1 || conditions.length > 8) {
    throw new Error('Browser semantic condition count must be in [1,8]');
  }

  const results = conditions.map((condition): BrowserSemanticConditionResult => {
    validateCondition(condition);
    if (condition.kind === 'url' || condition.kind === 'title') {
      const actual = condition.kind === 'url' ? snapshot.url : snapshot.title;
      const matched = matchText(
        actual,
        condition.value,
        condition.operator,
        condition.ignoreCase === true,
      );
      return Object.freeze({
        condition,
        matched,
        evidence: condition.kind === 'url'
          ? Object.freeze({ url: snapshot.url })
          : Object.freeze({ title: snapshot.title }),
      });
    }

    const found = snapshot.nodes.find((node) => nodeMatches(node, condition));
    const expectedPresent = condition.present !== false;
    const matched = expectedPresent ? found !== undefined : found === undefined;
    return Object.freeze({
      condition,
      matched,
      ...(found === undefined ? {} : {
        evidence: Object.freeze({
          ref: found.ref,
          role: found.role,
          name: found.name,
          ...(found.value === undefined ? {} : { value: found.value }),
        }),
      }),
    });
  });

  return Object.freeze({
    matched: mode === 'all'
      ? results.every((result) => result.matched)
      : results.some((result) => result.matched),
    mode,
    results: Object.freeze(results),
  });
}
