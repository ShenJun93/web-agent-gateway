import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { McpRemoteRelayExecutionPort } from '../src/remote-relay-mcp-execution.js';

test('remote relay MCP execution port reuses server discovery and preserves full native MCP result', async (t) => {
  const port = new McpRemoteRelayExecutionPort(() => {
    const server = new McpServer({ name: 'relay-test', version: '1.0.0' });
    server.registerTool('native.image', {
      description: 'Return native MCP image + text content.',
      inputSchema: z.object({ label: z.string() }).strict(),
    }, async ({ label }) => ({
      content: [
        { type: 'image' as const, data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'text' as const, text: label },
      ],
      structuredContent: { label, mime_type: 'image/png' },
    }));
    return server;
  });
  t.after(() => port.close());

  const manifest = await port.listToolManifest() as Array<{ name?: unknown }>;
  assert.deepEqual(manifest.map((tool) => tool.name), ['native.image']);

  const response = await port.callTool({
    tool: 'native.image',
    arguments: { label: 'preserve-me' },
  });
  assert.equal(response.ok, true);
  const result = response.result as {
    content?: Array<Record<string, unknown>>;
    structuredContent?: unknown;
  };
  assert.deepEqual(result.structuredContent, {
    label: 'preserve-me',
    mime_type: 'image/png',
  });
  assert.deepEqual(result.content, [
    { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    { type: 'text', text: 'preserve-me' },
  ]);
});

test('remote relay MCP execution port preserves MCP isError results instead of hiding protocol semantics', async (t) => {
  const port = new McpRemoteRelayExecutionPort(() => {
    const server = new McpServer({ name: 'relay-error-test', version: '1.0.0' });
    server.registerTool('expected.error', {
      inputSchema: z.object({}).strict(),
    }, async () => ({
      isError: true,
      content: [{ type: 'text' as const, text: 'bounded failure' }],
      structuredContent: { error_class: 'EXPECTED' },
    }));
    return server;
  });
  t.after(() => port.close());

  const response = await port.callTool({ tool: 'expected.error', arguments: {} });
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    isError: true,
    content: [{ type: 'text', text: 'bounded failure' }],
    structuredContent: { error_class: 'EXPECTED' },
  });
});
