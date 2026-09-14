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
  const context = createContext({    document,
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
  };  const turn = {
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
    },    querySelectorAll(selector: string) {
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
  };  const messages = await runObserver(documentWith([turn]));
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
  };  const messages = await runObserver(documentWith([turn]));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].codeBlocks, [{ language: 'wag-tool', text: json }]);
  assert.equal(messages[0].text.includes('Thinking summary'), true);
  assert.equal(messages[0].text.includes('workspace.open'), true);
});
