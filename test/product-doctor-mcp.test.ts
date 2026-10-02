import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProductDoctorMcpReport,
  type ProductDoctorLocalSnapshot,
  type ProductDoctorMcpInput,
} from '../src/product-doctor-mcp.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EXT_SHA = 'b'.repeat(64);

function healthyLocal(): ProductDoctorLocalSnapshot {
  return {
    supervisorRunning: true,
    maintenanceActive: false,
    tunnelHealth: true,
    tunnelReady: true,
    devspaceReady: true,
    installedExtensionSha256: EXT_SHA,
    cliDoctorSupportReady: true,
  };
}

function healthyInput(): ProductDoctorMcpInput {
  return {
    generatedAtUtc: '2026-10-02T13:00:00.000Z',
    gatewayHealth: { status: 'ok', executor: 'devspace' },
    runtime: {
      deployed: true,
      source_head: HEAD,
      extension_source_head: HEAD,
      extension_sha256: EXT_SHA,
      capability: 'autonomous-local-runtime-v1',
      cli_path: 'E:/WAG-Runtime/fixture/dist/cli.js',
    },
    browserExtension: {
      connected: true,
      observedSourceHead: HEAD,
      expectedSourceHead: HEAD,
      match: true,
      reloadRequested: false,
      lastError: null,
    },
    productConfig: {
      schema: 'WAG_LOCAL_PRODUCT_CONFIG_V1',
      capabilities: {
        browser_enabled: true,
        remote_git_push_enabled: true,
      },
    },
    mcpTools: [
      'health',
      'git.remote.inspect',
      'git.push',
      'git.push.result',
      'machine.media.inspect',
      'verify.media',
      'browser.upload_file',
      'browser.download',
      'artifact.list',
      'artifact.describe',
      'artifact.export',
      'browser.wait_for',
      'browser.assert',
      'browser.media.inspect',
      'product.doctor',
    ],
    local: healthyLocal(),
  };
}

test('MCP product doctor reports PASS for coherent runtime, extension, supervisor and semantic capabilities', () => {
  const report = buildProductDoctorMcpReport(healthyInput()) as {
    schema: string;
    status: string;
    summary: { pass: number; warn: number; fail: number };
    blockers: string[];
    warnings: string[];
    next_actions: string[];
    checks: Array<{ id: string; status: string }>;
  };

  assert.equal(report.schema, 'WAG_LOCAL_PRODUCT_DOCTOR_MCP_V1');
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.next_actions, []);
  assert.equal(report.summary.fail, 0);
  assert.ok(report.checks.every((check) => check.status === 'PASS'));
});

test('MCP product doctor fails closed on installed extension byte drift', () => {
  const input = healthyInput();
  input.local = {
    ...input.local,
    installedExtensionSha256: 'c'.repeat(64),
  };
  const report = buildProductDoctorMcpReport(input) as {
    status: string;
    blockers: string[];
    checks: Array<{ id: string; code: string; status: string }>;
  };

  assert.equal(report.status, 'FAIL');
  assert.ok(report.blockers.includes('extension_assets'));
  assert.deepEqual(
    report.checks.find((check) => check.id === 'extension_assets'),
    {
      id: 'extension_assets',
      status: 'FAIL',
      code: 'WAG_DOCTOR_EXTENSION_ASSETS_MISMATCH',
      message: 'Installed browser extension bytes do not match the active runtime release.',
    },
  );
});

test('MCP product doctor fails when remote Git policy and published semantic tools disagree', () => {
  const input = healthyInput();
  input.mcpTools = input.mcpTools.filter((name) => name !== 'git.push.result');
  const report = buildProductDoctorMcpReport(input) as {
    status: string;
    blockers: string[];
  };

  assert.equal(report.status, 'FAIL');
  assert.ok(report.blockers.includes('git_policy'));
});

test('MCP product doctor treats active bounded promotion maintenance as WARN, not FAIL', () => {
  const input = healthyInput();
  input.local = { ...input.local, maintenanceActive: true };
  const report = buildProductDoctorMcpReport(input) as {
    status: string;
    warnings: string[];
    blockers: string[];
  };

  assert.equal(report.status, 'WARN');
  assert.deepEqual(report.blockers, []);
  assert.ok(report.warnings.includes('maintenance'));
});

test('MCP product doctor does not require browser-only capabilities when browser integration is disabled', () => {
  const input = healthyInput();
  input.productConfig = {
    schema: 'WAG_LOCAL_PRODUCT_CONFIG_V1',
    capabilities: {
      browser_enabled: false,
      remote_git_push_enabled: true,
    },
  };
  input.browserExtension = undefined;
  input.mcpTools = input.mcpTools.filter((name) => !name.startsWith('browser.') && !name.startsWith('artifact.'));
  const report = buildProductDoctorMcpReport(input) as {
    status: string;
    checks: Array<{ id: string; status: string }>;
  };

  assert.equal(report.status, 'PASS');
  for (const id of ['extension_release', 'browser_upload', 'browser_download', 'artifact_lifecycle', 'browser_reliability']) {
    assert.equal(report.checks.find((check) => check.id === id)?.status, 'PASS');
  }
});


test('MCP product doctor fails when browser download capability is missing from a browser-enabled surface', () => {
  const input = healthyInput();
  input.mcpTools = input.mcpTools.filter((name) => name !== 'browser.download');
  const report = buildProductDoctorMcpReport(input) as {
    status: string;
    blockers: string[];
    checks: Array<{ id: string; status: string; code: string }>;
  };

  assert.equal(report.status, 'FAIL');
  assert.ok(report.blockers.includes('browser_download'));
  assert.deepEqual(
    report.checks.find((check) => check.id === 'browser_download'),
    {
      id: 'browser_download',
      status: 'FAIL',
      code: 'WAG_DOCTOR_BROWSER_DOWNLOAD_MISSING',
      message: 'Semantic browser download capture is missing.',
    },
  );
});

test('MCP product doctor fails when artifact lifecycle is missing from a browser-enabled surface', () => {
  const input = healthyInput();
  input.mcpTools = input.mcpTools.filter((name) => name !== 'artifact.export');
  const report = buildProductDoctorMcpReport(input) as {
    status: string;
    blockers: string[];
    checks: Array<{ id: string; status: string; code: string }>;
  };

  assert.equal(report.status, 'FAIL');
  assert.ok(report.blockers.includes('artifact_lifecycle'));
  assert.deepEqual(
    report.checks.find((check) => check.id === 'artifact_lifecycle'),
    {
      id: 'artifact_lifecycle',
      status: 'FAIL',
      code: 'WAG_DOCTOR_ARTIFACT_LIFECYCLE_MISSING',
      message: 'Artifact lifecycle/export surface is incomplete.',
    },
  );
});
