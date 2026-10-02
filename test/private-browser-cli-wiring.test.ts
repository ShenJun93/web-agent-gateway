import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import test from 'node:test';
import { main, type CliDependencies } from '../src/cli.js';
import type { BrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';
import type { RepositoryEngineeringRuntime } from '../src/repository-engineering-runtime.js';

test('serve-stdio forwards the private BrowserPort context without allocating it in the CLI', async () => {
  const browserContext = {} as BrowserMcpContext;
  const stdioOptions: Record<string, unknown>[] = [];
  const engineering: RepositoryEngineeringRuntime = {
    profile: { inspect: true, mutation: true, gitCommit: false, browser: true },
    browserContext,
    async attach() {},
    async close() {},
  };
  const deps: CliDependencies = {
    env: {},
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    loadConfig: async () => ({
      allowedRoots: [process.cwd()],
      devspace: {
        baseUrl: 'http://127.0.0.1:7676',
        resourceUrl: 'http://127.0.0.1:7676/mcp',
      },
      verifyProfiles: {},
    }),
    bootstrap: async () => ({
      gateway: {} as never,
      executor: {} as never,
      health: { status: 'ok', executor: 'devspace', protocolVersion: 'test', toolCount: 6 },
      async close() {},
    }),
    startStdio: async (options) => {
      stdioOptions.push(options as unknown as Record<string, unknown>);
      return { async close() {} };
    },
    waitForShutdown: async () => {},
    telemetry: { record() {} },
    startRepositoryEngineering: async () => engineering,
  };

  assert.equal(await main(['serve-stdio', '--config', resolve('private.json')], deps), 0);
  assert.equal(stdioOptions.length, 1);
  assert.equal(stdioOptions[0]!.browserContext, browserContext);
});


test('product health self-probe tells repository engineering to skip the single-owner browser control socket', async () => {
  const stdioOptions: Record<string, unknown>[] = [];
  const observed: unknown[] = [];
  const engineering: RepositoryEngineeringRuntime = {
    profile: { inspect: true, mutation: true, gitCommit: false, browser: true },
    browserContext: {} as BrowserMcpContext,
    async attach() {},
    async close() {},
  };
  const deps: CliDependencies = {
    env: { WAG_PRODUCT_HEALTH_PROBE: '1' },
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    loadConfig: async () => ({
      allowedRoots: [process.cwd()],
      devspace: {
        baseUrl: 'http://127.0.0.1:7676',
        resourceUrl: 'http://127.0.0.1:7676/mcp',
      },
      verifyProfiles: {},
    }),
    bootstrap: async () => ({
      gateway: {} as never,
      executor: {} as never,
      health: { status: 'ok', executor: 'devspace', protocolVersion: 'test', toolCount: 6 },
      async close() {},
    }),
    startStdio: async (options) => {
      stdioOptions.push(options as unknown as Record<string, unknown>);
      return { async close() {} };
    },
    waitForShutdown: async () => {},
    telemetry: { record() {} },
    startRepositoryEngineering: async (_config, options) => {
      observed.push(options);
      return engineering;
    },
  };

  assert.equal(await main(['serve-stdio', '--config', resolve('private.json')], deps), 0);
  assert.deepEqual(observed, [{ skipBrowserControlServer: true }]);
  assert.equal(stdioOptions.length, 1);
});
