import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import type { DevspaceExecutor } from '../src/executor/devspace.js';
import { createLocalMachineContext } from '../src/local-machine-runtime.js';
import {
  assertGenericExecutionRemoteEffectPolicy,
  nextTerminalRemoteEffectPolicyBuffer,
} from '../src/remote-effect-policy.js';
import { createGateway } from '../src/server.js';
import { WorkspaceIdentityRegistry } from '../src/workspace-identity.js';

const CWD = process.cwd();

test('generic argv policy denies direct Git remote mutations and GitHub CLI', async () => {
  const denied: readonly (readonly string[])[] = [
    ['git', 'push', 'origin', 'HEAD'],
    ['git', '-C', '.', 'push', 'origin', 'HEAD'],
    ['git', '-c', 'credential.helper=manager', 'push', 'origin', 'HEAD'],
    ['git', '--git-dir', '.git', 'push', 'origin', 'HEAD'],
    ['git', '--work-tree', '.', 'push', 'origin', 'HEAD'],
    ['git', 'send-pack', 'origin'],
    ['git-send-pack', 'origin'],
    ['git-http-push', 'origin'],
    ['gh', 'pr', 'create'],
    ['gh.exe', 'repo', 'view'],
  ];
  for (const argv of denied) {
    await assert.rejects(
      () => assertGenericExecutionRemoteEffectPolicy(argv, CWD),
      /Gateway denied/,
      argv.join(' '),
    );
  }
});

test('generic argv policy parses global Git options before allowing local/read operations', async () => {
  for (const argv of [
    ['git', 'status', '--short'],
    ['git', '-C', '.', 'rev-parse', 'HEAD'],
    ['git', '-c', 'core.fsmonitor=false', 'diff', '--stat'],
    ['git', '--git-dir=.git', '--work-tree=.', 'status', '--short'],
    ['git', 'ls-remote', '--heads', 'https://example.invalid/repo.git'],
  ]) {
    await assert.doesNotReject(
      () => assertGenericExecutionRemoteEffectPolicy(argv, CWD),
      argv.join(' '),
    );
  }
});

test('alias injection, configured aliases and external git subcommands fail closed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-remote-effect-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run('git', ['init', '--quiet', dir]);
  await run('git', ['-C', dir, 'config', 'alias.ship', 'push']);

  await assert.rejects(
    () => assertGenericExecutionRemoteEffectPolicy(['git', '-c', 'alias.ship=push', 'ship'], dir),
    /ambiguous Git invocation/,
  );
  await assert.rejects(
    () => assertGenericExecutionRemoteEffectPolicy(['git', 'ship'], dir),
    /Git alias/,
  );
  await assert.rejects(
    () => assertGenericExecutionRemoteEffectPolicy(['git', 'not-a-builtin'], dir),
    /unrecognized Git subcommand/,
  );
});

test('shell indirection is fail-closed for Git and GitHub CLI', async () => {
  const encoded = Buffer.from('git push origin HEAD', 'utf16le').toString('base64');
  for (const argv of [
    ['cmd.exe', '/c', 'git', 'push', 'origin', 'HEAD'],
    ['powershell.exe', '-NoProfile', '-Command', 'git status'],
    ['powershell.exe', '-NoProfile', '-Command', '&\"git\" push origin HEAD'],
    ['powershell.exe', '-NoProfile', '-Command', "& 'git.exe' push origin HEAD"],
    ['powershell.exe', '-EncodedCommand', encoded],
    ['cmd.exe', '/c', '\"git.exe\" push origin HEAD'],
    ['bash', '-c', "'git' push origin HEAD"],
    ['bash', '-c', 'gh pr create'],
  ]) {
    await assert.rejects(
      () => assertGenericExecutionRemoteEffectPolicy(argv, CWD),
      /shell|Git\/GitHub CLI|Gateway denied/,
      argv.join(' '),
    );
  }
});

test('interactive terminal gate catches commands split across input chunks', () => {
  let state = '';
  state = nextTerminalRemoteEffectPolicyBuffer(state, 'gi');
  assert.equal(state, 'gi');
  assert.throws(
    () => nextTerminalRemoteEffectPolicyBuffer(state, 't '),
    /Git\/GitHub CLI/,
  );

  state = '';
  state = nextTerminalRemoteEffectPolicyBuffer(state, 'gix\b');
  assert.equal(state, 'gi');
  assert.throws(
    () => nextTerminalRemoteEffectPolicyBuffer(state, 't push\n'),
    /Git\/GitHub CLI/,
  );

  assert.equal(nextTerminalRemoteEffectPolicyBuffer('echo ok', '\u0003'), '');
});

test('DevSpace command.run and verify.run deny generic remote Git before executor dispatch', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wag-devspace-remote-policy-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let execCalls = 0;
  const executor = {
    async openWorkspace() { return 'devspace_ws'; },
    async execCommand() {
      execCalls += 1;
      return { output: '', exitCode: 0, running: false };
    },
  } as unknown as DevspaceExecutor;

  const gateway = createGateway({
    executor,
    allowedRoots: [dir],
    verifyProfiles: { remote: { argv: ['git', 'push', 'origin', 'HEAD'] } },
  });
  const opened = await gateway.openWorkspace(dir);

  await assert.rejects(
    () => gateway.commandRun(opened.workspaceId, ['git', 'push', 'origin', 'HEAD']),
    /Gateway denied/,
  );
  await assert.rejects(
    () => gateway.verifyRun(opened.workspaceId, 'remote'),
    /Gateway denied/,
  );
  assert.equal(execCalls, 0);
});

test('persistent terminal broker closes direct Git bypasses before writing them to the shell', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-persistent-terminal-remote-policy-'));
  const root = await realpath(dir);
  const statePath = join(dir, 'state.sqlite');
  const terminalRegistryPath = join(dir, 'terminals');
  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const context = createLocalMachineContext({
    store,
    callerContext: createGatewayCallerContext({
      ownerId: 'local.private.stdio',
      sessionId: 'session_persistent_terminal_remote_policy',
      adapterId: 'private.stdio.v1',
    }),
    workspaceIdentities: identities,
    killSwitch: () => false,
    terminalRegistryPath,
  });
  let workspaceId = '';
  let terminalId = '';
  t.after(async () => {
    if (workspaceId && terminalId) {
      await context.terminalClose(workspaceId, terminalId).catch(() => undefined);
    }
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  workspaceId = (await context.open(root) as { workspace_id: string }).workspace_id;
  const terminal = await context.terminalOpen(
    workspaceId,
    process.platform === 'win32' ? 'powershell' : 'bash',
  ) as { terminal_id: string };
  terminalId = terminal.terminal_id;

  await assert.rejects(
    () => context.terminalInput(
      workspaceId,
      terminalId,
      Buffer.from('git push origin HEAD\n', 'utf8').toString('base64'),
    ),
    /terminal broker refused request/,
  );
});

test('local-machine command/process/terminal surfaces close direct Git and gh bypasses', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-local-remote-policy-'));
  const root = await realpath(dir);
  const statePath = join(dir, 'state.sqlite');
  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const context = createLocalMachineContext({
    store,
    callerContext: createGatewayCallerContext({
      ownerId: 'local.private.stdio',
      sessionId: 'session_remote_effect_policy',
      adapterId: 'private.stdio.v1',
    }),
    workspaceIdentities: identities,
    killSwitch: () => false,
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const opened = await context.open(root) as { workspace_id: string };
  await assert.rejects(
    () => context.commandRun(opened.workspace_id, ['git', '-C', root, 'push', 'origin', 'HEAD']),
    /Gateway denied/,
  );
  await assert.rejects(
    () => context.processStart(opened.workspace_id, ['gh', 'pr', 'create']),
    /Gateway denied/,
  );

  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const terminal = await context.terminalOpen(opened.workspace_id, shell) as { terminal_id: string };
  try {
    await assert.rejects(
      () => context.terminalInput(
        opened.workspace_id,
        terminal.terminal_id,
        Buffer.from('git status\n', 'utf8').toString('base64'),
      ),
      /Git\/GitHub CLI/,
    );
  } finally {
    await context.terminalClose(opened.workspace_id, terminal.terminal_id).catch(() => undefined);
  }
});
