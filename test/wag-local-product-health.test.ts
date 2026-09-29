import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyStatus, parseWrapper } from '../scripts/wag-local-product-health.js';

test('parseWrapper resolves one WAG runtime CLI and private config', () => {
  const binding = parseWrapper([
    '#!/usr/bin/env bash',
    'exec node.exe \\',
    '  E:/WAG-Runtime/abcdef123456/dist/cli.js \\',
    '  serve-stdio \\',
    '  --config E:/AI-BROWSER/wag-acceptance/wag-live.config.json',
  ].join('\n'));
  assert.deepEqual(binding, {
    cliPath: 'E:/WAG-Runtime/abcdef123456/dist/cli.js',
    configPath: 'E:/AI-BROWSER/wag-acceptance/wag-live.config.json',
  });
});

test('parseWrapper rejects an ambiguous or missing binding', () => {
  assert.throws(() => parseWrapper('#!/bin/sh\necho nope\n'), /WAG_WRAPPER_BINDING_INVALID/);
});

test('classifyStatus requires all executable layers for READY', () => {
  assert.equal(classifyStatus({
    devspaceDiscovery: true,
    tunnelReady: true,
    mcpRoundTrip: true,
  }), 'READY');
  assert.equal(classifyStatus({
    devspaceDiscovery: true,
    tunnelReady: false,
    mcpRoundTrip: true,
  }), 'DEGRADED');
  assert.equal(classifyStatus({
    devspaceDiscovery: false,
    tunnelReady: false,
    mcpRoundTrip: false,
  }), 'OFFLINE');
});
