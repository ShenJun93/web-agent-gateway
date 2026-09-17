import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseBrowserAdapterRequest, type BrowserAdapterRequest } from '../src/browser-adapter/protocol.js';
import { parseChatGptObservation, parseChatGptToolCall } from '../browser/extension/chatgpt-call-parser.js';

type ToolCallRequest = Extract<BrowserAdapterRequest, { type: 'tool.call' }>;

function envelope(call: ReturnType<typeof parseChatGptToolCall>): ToolCallRequest {
  assert.ok(call);
  const parsed = parseBrowserAdapterRequest({
    version: 2,
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

  const searchBlock = '```wag-tool\n{"tool":"repo.search","arguments":{"workspace_id":"ws_123","query":"canonicalizeTicketId","max_results":20,"context_lines":1}}\n```';
  const parsedSearch = parseChatGptToolCall(searchBlock);
  assert.deepEqual(parsedSearch, {
    tool: 'repo.search',
    arguments: {
      workspace_id: 'ws_123',
      query: 'canonicalizeTicketId',
      max_results: 20,
      context_lines: 1,
    },
  });
  assert.equal(envelope(parsedSearch).tool, 'repo.search');

  const minimalSearch = parseChatGptToolCall('```wag-tool\n{"tool":"repo.search","arguments":{"workspace_id":"ws_123","query":"foo"}}\n```');
  assert.deepEqual(minimalSearch, {
    tool: 'repo.search',
    arguments: { workspace_id: 'ws_123', query: 'foo' },
  });
  assert.equal(envelope(minimalSearch).tool, 'repo.search');

  const snapshotBlock = '```wag-tool\n{"tool":"repo.snapshot","arguments":{"workspace_id":"ws_123","max_files":100}}\n```';
  const parsedSnapshot = parseChatGptToolCall(snapshotBlock);
  assert.deepEqual(parsedSnapshot, {
    tool: 'repo.snapshot',
    arguments: { workspace_id: 'ws_123', max_files: 100 },
  });
  assert.equal(envelope(parsedSnapshot).tool, 'repo.snapshot');

  const minimalSnapshot = parseChatGptToolCall('```wag-tool\n{"tool":"repo.snapshot","arguments":{"workspace_id":"ws_123"}}\n```');
  assert.deepEqual(minimalSnapshot, {
    tool: 'repo.snapshot',
    arguments: { workspace_id: 'ws_123' },
  });
  assert.equal(envelope(minimalSnapshot).tool, 'repo.snapshot');
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

test('chatgpt parser rejects repo.search invalid inputs', () => {
  // unknown/extra authority keys
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","session_id":"s"}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","extra":"x"}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","provider":"chatgpt"}}')), undefined);

  // query > 256 UTF-8 bytes
  assert.equal(parseChatGptToolCall(block(JSON.stringify({ tool: 'repo.search', arguments: { workspace_id: 'ws', query: 'a'.repeat(257) } }))), undefined);
  assert.equal(parseChatGptToolCall(block(JSON.stringify({ tool: 'repo.search', arguments: { workspace_id: 'ws', query: '日'.repeat(100) } }))), undefined);

  // NUL, CR, LF in query
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"a\\u0000b"}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"a\\nb"}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"a\\rb"}}')), undefined);

  // empty query
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":""}}')), undefined);

  // invalid booleans
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","ignore_case":"true"}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","ignore_case":1}}')), undefined);

  // invalid / out-of-range max_results
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","max_results":0}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","max_results":51}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","max_results":-1}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","max_results":1.5}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","max_results":"20"}}')), undefined);

  // invalid / out-of-range context_lines
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","context_lines":-1}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","context_lines":3}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","context_lines":1.5}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"ws","query":"q","context_lines":"1"}}')), undefined);

  // invalid workspace_id
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.search","arguments":{"workspace_id":"","query":"q"}}')), undefined);
  assert.equal(parseChatGptToolCall(block(JSON.stringify({ tool: 'repo.search', arguments: { workspace_id: 'w'.repeat(257), query: 'q' } }))), undefined);
});

test('chatgpt parser rejects repo.snapshot invalid inputs', () => {
  // unknown/extra keys
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.snapshot","arguments":{"workspace_id":"ws","extra":"val"}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.snapshot","arguments":{"workspace_id":"ws","path":"src"}}')), undefined);

  // invalid / out-of-range max_files
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.snapshot","arguments":{"workspace_id":"ws","max_files":0}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.snapshot","arguments":{"workspace_id":"ws","max_files":201}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.snapshot","arguments":{"workspace_id":"ws","max_files":1.5}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.snapshot","arguments":{"workspace_id":"ws","max_files":"100"}}')), undefined);

  // missing workspace_id
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.snapshot","arguments":{"max_files":100}}')), undefined);
  assert.equal(parseChatGptToolCall(block('{"tool":"repo.snapshot","arguments":{}}')), undefined);
});

test('chatgpt parser rejects non-v2/consequential tools', () => {
  for (const tool of ['verify.run', 'mutation.preview', 'mutation.result', 'file.patch', 'terminal.exec', 'browser.open', 'job.get']) {
    assert.equal(parseChatGptToolCall(block(JSON.stringify({ tool, arguments: {} }))), undefined);
  }
});
