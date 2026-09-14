import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const json = '{"tool":"workspace.open","arguments":{"path":"C:\\\\WagFixture"}}';

function content(text: string, language = '', codeText = '') {
  const codeNode = { innerText: codeText, textContent: codeText, className: language ? `language-${language}` : '' };
  return {
    innerText: text,
    textContent: text,
    querySelectorAll(selector: string) {
      return selector === 'pre code' && codeText ? [codeNode] : [];
    },
  };
}

async function runObserver(document: object) {
  const source = await readFile(new URL('../browser/extension/content/chatgpt.js', import.meta.url), 'utf8');
  const messages: unknown[] = [];
  class MutationObserver {
    constructor(_callback: () => void) {}
    observe() {}
  }
  const context = createContext({
    document,
    MutationObserver,
    TextEncoder,
    location: { pathname: '/uc/test' },
    queueMicrotask: (callback: () => void) => callback(),
    chrome: {
      runtime: {
        sendMessage(message: unknown) {
          messages.push(message);
          return { catch() {} };
        },
      },
    },
  });
  runInContext(source, context);
  return JSON.parse(JSON.stringify(messages));
}

function documentWith(current: unknown[], legacy: unknown[] = []) {
  return {
    documentElement: {},
    querySelectorAll(selector: string) {
      if (selector === '[data-testid^="conversation-turn-"][data-turn="assistant"]') return current;
      if (selector === '[data-message-author-role="assistant"]') return legacy;
      return [];
    },
  };
}
test('chatgpt content observer forwards current assistant turn wrappers with rendered code metadata', async () => {
  const answer = content(json, 'wag-tool', json);
  const turn = {
    querySelector(selector: string) {
      return selector === '.markdown, .prose, [class*="markdown"]' ? answer : undefined;
    },
    querySelectorAll() { return [answer]; },
  };
  const messages = await runObserver(documentWith([turn]));
  assert.deepEqual(messages, [{
    type: 'provider.observed_text',
    text: json,
    codeBlocks: [{ language: 'wag-tool', text: json }],
    conversationHint: '/uc/test',
  }]);
});

test('chatgpt content observer aggregates all rendered containers in one assistant turn', async () => {
  const reasoning = content('Reasoning summary');
  const answer = content(json, 'wag-tool', json);
  const roleNode = {
    querySelectorAll(selector: string) {
      return selector === '.markdown, .prose, [class*="markdown"]' ? [reasoning, answer] : [];
    },
  };
  const turn = {
    querySelector(selector: string) {
      if (selector === '[data-message-author-role="assistant"]') return roleNode;
      if (selector === '.markdown, .prose, [class*="markdown"]') return reasoning;
      return undefined;
    },
    querySelectorAll(selector: string) {
      return selector === '.markdown, .prose, [class*="markdown"]' ? [reasoning, answer] : [];
    },
  };
  const messages = await runObserver(documentWith([turn]));
  assert.deepEqual(messages, [{
    type: 'provider.observed_text',
    text: `Reasoning summary\n${json}`,
    codeBlocks: [{ language: 'wag-tool', text: json }],
    conversationHint: '/uc/test',
  }]);
});

test('chatgpt content observer preserves the legacy assistant-role fallback', async () => {
  const answer = content(json, 'wag-tool', json);
  const legacy = {
    querySelector(selector: string) {
      return selector === '.markdown, .prose, [class*="markdown"]' ? answer : undefined;
    },
    querySelectorAll(selector: string) {
      return selector === '.markdown, .prose, [class*="markdown"]' ? [answer] : [];
    },
  };
  const messages = await runObserver(documentWith([], [legacy]));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].codeBlocks, [{ language: 'wag-tool', text: json }]);
});

test('chatgpt content observer preserves multiple non-empty code blocks for fail-closed parsing', async () => {
  const blocks = [
    { innerText: '', textContent: '', className: 'language-text' },
    { innerText: '', textContent: '', className: 'language-text' },
    { innerText: '', textContent: '', className: 'language-text' },
    { innerText: json, textContent: json, className: 'language-wag-tool' },
    { innerText: '{}', textContent: '{}', className: 'language-json' },
  ];
  const answer = {
    innerText: json,
    textContent: json,
    querySelectorAll(selector: string) { return selector === 'pre code' ? blocks : []; },
  };
  const turn = {
    querySelector() { return undefined; },
    querySelectorAll(selector: string) {
      return selector === '.markdown, .prose, [class*="markdown"]' ? [answer] : [];
    },
  };
  const messages = await runObserver(documentWith([turn]));
  assert.equal(messages[0].codeBlocks.length, 2);
});

test('chatgpt content observer aggregates rendered containers across sibling assistant role nodes', async () => {
  const reasoning = content('Thinking summary');
  const answer = content(json, 'wag-tool', json);
  const firstRole = {
    querySelectorAll(selector: string) {
      return selector === '.markdown, .prose, [class*="markdown"]' ? [reasoning] : [];
    },
  };
  const secondRole = {
    querySelectorAll(selector: string) {
      return selector === '.markdown, .prose, [class*="markdown"]' ? [answer] : [];
    },
  };
  const turn = {
    querySelector(selector: string) {
      return selector === '[data-message-author-role="assistant"]' ? firstRole : undefined;
    },
    querySelectorAll(selector: string) {
      if (selector === '[data-message-author-role="assistant"]') return [firstRole, secondRole];
      if (selector === '.markdown, .prose, [class*="markdown"]') return [reasoning, answer];
      return [];
    },
  };
  const messages = await runObserver(documentWith([turn]));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].codeBlocks, [{ language: 'wag-tool', text: json }]);
  assert.equal(messages[0].text.includes('Thinking summary'), true);
  assert.equal(messages[0].text.includes('workspace.open'), true);
});

test('chatgpt content observer accepts the live completed assistant turn shape', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/chatgpt-live-assistant-turn.json', import.meta.url), 'utf8'));
  assert.equal(fixture.scope, 'sanitized structural selector evidence from supported-host Attempt 6');
  assert.equal(fixture.tag, 'LI');
  assert.equal(fixture.attributes['data-message-role'], 'assistant');
  assert.equal(fixture.code.parentTag, 'PRE');
  const language = fixture.code.className.replace(/^language-/, '');
  const answer = content(json, language, json);
  const turn = {
    innerText: json,
    textContent: json,
    getAttribute(name: string) { return fixture.attributes[name] ?? null; },
    querySelectorAll(selector: string) {
      if (selector === '.markdown, .prose, [class*="markdown"]') return [];
      if (selector === '[data-message-author-role="assistant"]') return [];
      if (selector === 'pre code') return answer.querySelectorAll(selector);
      return [];
    },
  };
  const document = {
    documentElement: {},
    querySelectorAll(selector: string) {
      if (selector === '[data-message-role="assistant"]') return [turn];
      return [];
    },
  };
  const messages = await runObserver(document);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].codeBlocks, [{ language: 'wag-tool', text: json }]);
});

test('chatgpt content observer waits for live completion and observes completion attributes', async () => {
  const source = await readFile(new URL('../browser/extension/content/chatgpt.js', import.meta.url), 'utf8');
  const messages: unknown[] = [];
  const answer = content(json, 'wag-tool', json);
  let completion: string | null = null;
  const turn = {
    innerText: json,
    textContent: json,
    getAttribute(name: string) { return name === 'data-message-complete' ? completion : null; },
    querySelectorAll(selector: string) {
      if (selector === 'pre code') return answer.querySelectorAll(selector);
      return [];
    },
  };
  let callback: (() => void) | undefined;
  let observeOptions: Record<string, unknown> | undefined;
  class MutationObserver {
    constructor(value: () => void) { callback = value; }
    observe(_target: unknown, options: Record<string, unknown>) { observeOptions = options; }
  }
  const document = {
    documentElement: {},
    querySelectorAll(selector: string) {
      if (selector === '[data-message-role="assistant"]') return [turn];
      return [];
    },
  };
  const context = createContext({
    document, MutationObserver, TextEncoder,
    location: { pathname: '/uc/live' },
    queueMicrotask: (value: () => void) => value(),
    chrome: { runtime: { sendMessage(message: unknown) {
      messages.push(message);
      return { catch() {} };
    } } },
  });
  runInContext(source, context);
  assert.equal(messages.length, 0);
  completion = 'true';
  assert.ok(callback);
  callback();
  assert.equal(messages.length, 1);
  callback();
  assert.equal(messages.length, 1);
  assert.equal(observeOptions?.attributes, true);
  assert.deepEqual(Array.from((observeOptions?.attributeFilter ?? []) as string[]), ['data-message-complete']);
});

test('chatgpt content observer never falls back while a live assistant turn is incomplete', async () => {
  const answer = content(json, 'wag-tool', json);
  const turn = {
    innerText: json,
    textContent: json,
    querySelectorAll(selector: string) {
      if (selector === '.markdown, .prose, [class*="markdown"]') return [answer];
      if (selector === 'pre code') return answer.querySelectorAll(selector);
      return [];
    },
  };
  const document = {
    documentElement: {},
    querySelectorAll(selector: string) {
      if (selector === '[data-message-role="assistant"]') return [turn];
      if (selector === '[data-testid^="conversation-turn-"][data-turn="assistant"]') return [turn];
      if (selector === '[data-message-author-role="assistant"]') return [turn];
      return [];
    },
  };
  const messages = await runObserver(document);
  assert.equal(messages.length, 0);
});

test('chatgpt content observer rejects explicit false completion without compatibility fallback', async () => {
  const answer = content(json, 'wag-tool', json);
  const turn = {
    innerText: json,
    textContent: json,
    getAttribute(name: string) { return name === 'data-message-complete' ? 'false' : null; },
    querySelectorAll(selector: string) {
      if (selector === '.markdown, .prose, [class*="markdown"]') return [answer];
      if (selector === 'pre code') return answer.querySelectorAll(selector);
      return [];
    },
  };
  const document = {
    documentElement: {},
    querySelectorAll(selector: string) {
      if (selector === '[data-message-role="assistant"]') return [turn];
      if (selector === '[data-testid^="conversation-turn-"][data-turn="assistant"]') return [turn];
      if (selector === '[data-message-author-role="assistant"]') return [turn];
      return [];
    },
  };
  const messages = await runObserver(document);
  assert.equal(messages.length, 0);
});
