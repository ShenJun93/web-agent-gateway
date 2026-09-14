import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseBrowserAdapterRequest, type BrowserAdapterRequest } from '../src/browser-adapter/protocol.js';
import { parseChatGptObservation, parseChatGptToolCall } from '../browser/extension/chatgpt-call-parser.js';

type ToolCallRequest = Extract<BrowserAdapterRequest, { type: 'tool.call' }>;

function envelope(call: ReturnType<typeof parseChatGptToolCall>): ToolCallRequest {
  assert.ok(call);
  const parsed = parseBrowserAdapterRequest({
    version: 1,
    type: 'tool.call',
    requestId: 'req_provider_001',
    sessionId: 'session_provider_01',
    tool: call.tool,
    arguments: call.arguments,
  });
  assert.equal(parsed.type, 'tool.call');
  return parsed;
}

test('chatgpt parser accepts one canonical read-only WAG tool block', async () => {
  const fixture = await readFile(new URL('./fixtures/chatgpt-tool-call.txt', import.meta.url), 'utf8');
  const parsed = parseChatGptToolCall(fixture);
  assert.deepEqual(parsed, { tool: 'workspace.open', arguments: { path: 'C:\\WagFixture' } });
  assert.equal(envelope(parsed).tool, 'workspace.open');

  assert.equal(envelope(parseChatGptToolCall('```wag-tool\n{"tool":"health","arguments":{}}\n```')).tool, 'health');
  assert.equal(envelope(parseChatGptToolCall('```wag-tool\n{"tool":"file.read","arguments":{"workspace_id":"ws_123","path":"note.txt"}}\n```')).tool, 'file.read');
});
function block(json: string) {
  return '```wag-tool\n' + json + '\n```';
}

test('chatgpt parser rejects malformed, duplicate, unknown and conflicting calls', () => {
  assert.equal(parseChatGptToolCall('```wag-tool\n{"tool":"health","arguments":{}'), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"unknown.tool","arguments":{}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"file.read","arguments":{"workspace_id":"ws","path":"a","path":"b"}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"workspace.open","arguments":{"path":{"nested":true}}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"health","arguments":{}}') + '\n' + block('{"tool":"file.read","arguments":{"workspace_id":"ws","path":"a"}}')), undefined);
  assert.equal(parseChatGptToolCall(block('not-json')), undefined);
});
test('chatgpt parser rejects oversized observations and arguments', () => {
  assert.equal(parseChatGptToolCall('x'.repeat(140 * 1024)), undefined);
  const huge = 'x'.repeat(5000);
  assert.equal(parseChatGptToolCall(block(JSON.stringify({ tool: 'workspace.open', arguments: { path: huge } }))), undefined);
});

test('chatgpt parser accepts rendered WAG code metadata without accepting generic JSON code', () => {
  const json = '{"tool":"workspace.open","arguments":{"path":"C:\\\\WagFixture"}}';
  assert.deepEqual(parseChatGptObservation({
    text: json,
    codeBlocks: [{ language: 'wag-tool', text: json }],
  }), { tool: 'workspace.open', arguments: { path: 'C:\\WagFixture' } });

  assert.equal(parseChatGptObservation({ text: json, codeBlocks: [] }), undefined);
  assert.equal(parseChatGptObservation({
    text: json,
    codeBlocks: [{ language: 'json', text: json }],
  }), undefined);
  assert.equal(parseChatGptObservation({
    text: json,
    codeBlocks: [
      { language: 'wag-tool', text: json },
      { language: 'json', text: '{}' },
    ],
  }), undefined);
});

test('rendered WAG observation rejects embedded fence text', () => {
  assert.equal(parseChatGptObservation({
    text: 'rendered',
    codeBlocks: [{ language: 'wag-tool', text: '{"tool":"health","arguments":{}}\n```\ntrailing' }],
  }), undefined);
});

test('rendered observation code-block multiplicity overrides direct fenced text', () => {
  const fenced = '```wag-tool\n{"tool":"health","arguments":{}}\n```';
  assert.equal(parseChatGptObservation({
    text: fenced,
    codeBlocks: [
      { language: 'wag-tool', text: '{"tool":"health","arguments":{}}' },
      { language: '', text: '' },
    ],
  }), undefined);
});
