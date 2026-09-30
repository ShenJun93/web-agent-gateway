import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyStatus, isDevelopmentCheckout, parseTunnelProfile, parseWrapper } from '../scripts/wag-local-product-health.js';

test('source checkout detection rejects a consumer repository ancestor', () => {
  assert.equal(isDevelopmentCheckout('C:\\repo\\wag', 'C:\\repo\\wag'), true);
  assert.equal(isDevelopmentCheckout('C:\\consumer\\node_modules\\web-agent-gateway', 'C:\\consumer'), false);
  assert.equal(isDevelopmentCheckout('C:\\consumer\\node_modules\\web-agent-gateway', null), false);
});

test('parseTunnelProfile resolves one absolute WSL wrapper command', () => {
  const wrapper = parseTunnelProfile([
    'config_version: 1',
    'mcp:',
    '  commands:',
    '    - channel: main',
    '      command: "/home/alice/.local/bin/wag-mcp-stdio.sh"',
  ].join('\n'));
  assert.equal(wrapper, '/home/alice/.local/bin/wag-mcp-stdio.sh');
  assert.throws(() => parseTunnelProfile('mcp:\n  commands: []\n'), /WAG_TUNNEL_PROFILE_INVALID/);
});

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
