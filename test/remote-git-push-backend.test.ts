import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  LocalRemoteGitPushBackend,
  canonicalRemotePushUrl,
  type RemoteGitCommandResult,
  type RemoteGitCommandRunner,
} from '../src/remote-git-push-backend.js';
import type { RemoteGitPushRecord } from '../src/remote-git-push-store.js';

const SOURCE = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const DEST = 'refs/heads/feat/remote-push-v1';
const URL = 'https://github.com/example/repo.git';
const execFileAsync = promisify(execFile);

class FakeRunner {
  calls: Array<{
    cwd: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
  }> = [];
  remoteOid: string | undefined = OLD;
  defaultBranch: string | undefined = 'refs/heads/main';
  fastForward = true;
  configOutput = 'local file:.git/config remote.origin.url\n';
  remoteUrl = URL;
  root = '';
  gitDir = '';
  commonDir = '';

  run: RemoteGitCommandRunner = async (cwd, args, options): Promise<RemoteGitCommandResult> => {
    this.calls.push({ cwd, args: [...args], env: { ...options.env } });

    if (args.includes('config')) {
      return { exitCode: this.configOutput === '' ? 1 : 0, stdout: this.configOutput, stderr: '' };
    }
    if (args.includes('rev-parse')) {
      if (args.includes('--show-toplevel')) return ok(this.root);
      if (args.includes('--absolute-git-dir')) return ok(this.gitDir);
      if (args.includes('--git-common-dir')) return ok(this.commonDir);
    }
    if (args.includes('remote') && args.includes('get-url')) return ok(this.remoteUrl);
    if (args.includes('cat-file')) return ok('');
    if (args.includes('check-ref-format')) return ok('');
    if (args.includes('merge-base')) {
      return { exitCode: this.fastForward ? 0 : 1, stdout: '', stderr: '' };
    }
    if (args.includes('rev-list')) return ok('2');
    if (args.includes('show')) return ok('feat: bounded remote push');
    if (args.includes('diff-tree')) return ok(' 2 files changed, 3 insertions(+), 1 deletion(-)');
    if (args.includes('ls-remote')) {
      const lines: string[] = [];
      if (this.defaultBranch !== undefined) {
        lines.push('ref: ' + this.defaultBranch + '\tHEAD');
        lines.push('f'.repeat(40) + '\tHEAD');
      }
      if (this.remoteOid !== undefined) lines.push(this.remoteOid + '\t' + DEST);
      return ok(lines.join('\n'));
    }
    if (args.includes('push')) {
      this.remoteOid = SOURCE;
      return ok('To ' + URL);
    }
    throw new Error('Unexpected fake git argv: ' + args.join(' '));
  };
}

function ok(stdout: string): RemoteGitCommandResult {
  return { exitCode: 0, stdout: stdout === '' ? '' : stdout + '\n', stderr: '' };
}

async function fixture(t: test.TestContext, runner = new FakeRunner()) {
  const base = await mkdtemp(join(tmpdir(), 'wag-remote-push-backend-'));
  const root = join(base, 'repo');
  const gitDir = join(root, '.git-worktree');
  const commonDir = join(root, '.git-common');
  const hooksDir = join(base, 'wag-owned-empty-hooks');
  await mkdir(root);
  await mkdir(gitDir);
  await mkdir(commonDir);
  runner.root = resolve(root);
  runner.gitDir = resolve(gitDir);
  runner.commonDir = resolve(commonDir);
  const backend = new LocalRemoteGitPushBackend({
    hooksDir,
    runner: runner.run,
    parentEnv: {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      GIT_SSH_COMMAND: 'attacker-controlled',
      GIT_CONFIG_COUNT: '999',
      GIT_CONFIG_KEY_0: 'core.sshCommand',
      GIT_CONFIG_VALUE_0: 'evil',
      SECRET_TOKEN: 'must-not-leak',
    },
  });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { root, hooksDir, backend, runner };
}

test('remote URL canonicalization accepts only credentialless https or explicit ssh URLs', () => {
  assert.equal(canonicalRemotePushUrl(URL), URL);
  assert.equal(
    canonicalRemotePushUrl('ssh://git@github.com/example/repo.git'),
    'ssh://git@github.com/example/repo.git',
  );

  for (const value of [
    'file:///tmp/repo.git',
    'git://github.com/example/repo.git',
    'ext::sh -c evil',
    'git@github.com:example/repo.git',
    'https://token@github.com/example/repo.git',
    'https://user:secret@github.com/example/repo.git',
    'ssh://git:secret@github.com/example/repo.git',
    'https://github.com/example/repo.git?token=x',
    'https://github.com/example/repo.git#fragment',
  ]) {
    assert.throws(() => canonicalRemotePushUrl(value), /denied|unsupported/i, value);
  }
});

test('planning binds repository, effective push URL, expected remote OID and fast-forward facts', async (t) => {
  const f = await fixture(t);
  const plan = await f.backend.plan(f.root, {
    remote: 'origin',
    sourceOid: SOURCE,
    destinationRef: DEST,
    reviewedOid: SOURCE,
  });

  assert.equal(plan.resolvedPushUrl, URL);
  assert.match(plan.repositoryIdentity, /^repo_[0-9a-f]{64}$/);
  assert.deepEqual(plan.expectedRemoteState, { kind: 'OID', oid: OLD });
  assert.equal(plan.sourceOid, SOURCE);
  assert.equal(plan.destinationRef, DEST);
  assert.equal(plan.aheadCommitCount, 2);
  assert.equal(plan.commitSubject, 'feat: bounded remote push');
  assert.match(plan.changedFilesSummary, /2 files changed/);
});

test('dangerous effective Git config is refused before any remote observation', async (t) => {
  for (const dangerous of [
    'alias.ship',
    'core.sshcommand',
    'core.hookspath',
    'credential.helper',
    'protocol.https.allow',
    'url.https://mirror/.insteadof',
    'url.ssh://mirror/.pushinsteadof',
    'remote.origin.pushurl',
    'hook.evil.command',
    'http.extraheader',
    'http.https://github.com/.proxy',
    'remote.origin.proxy',
  ]) {
    const runner = new FakeRunner();
    runner.configOutput = 'local file:.git/config ' + dangerous + '\n';
    const f = await fixture(t, runner);
    await assert.rejects(
      f.backend.plan(f.root, { remote: 'origin', sourceOid: SOURCE, destinationRef: DEST }),
      /dangerous effective Git config/i,
      dangerous,
    );
    assert.equal(runner.calls.some((call) => call.args.includes('ls-remote')), false);
  }
});

test('planning refuses remote default branch and non-fast-forward source', async (t) => {
  const defaultRunner = new FakeRunner();
  defaultRunner.defaultBranch = DEST;
  const a = await fixture(t, defaultRunner);
  await assert.rejects(
    a.backend.plan(a.root, { remote: 'origin', sourceOid: SOURCE, destinationRef: DEST }),
    /default branch/i,
  );

  const unknownDefaultRunner = new FakeRunner();
  unknownDefaultRunner.defaultBranch = undefined;
  const b = await fixture(t, unknownDefaultRunner);
  await assert.rejects(
    b.backend.plan(b.root, { remote: 'origin', sourceOid: SOURCE, destinationRef: DEST }),
    /could not prove remote Git default branch/i,
  );

  const nffRunner = new FakeRunner();
  nffRunner.fastForward = false;
  const c = await fixture(t, nffRunner);
  await assert.rejects(
    c.backend.plan(c.root, { remote: 'origin', sourceOid: SOURCE, destinationRef: DEST }),
    /non-fast-forward/i,
  );
});

test('execute uses verified URL + exact OID refspec + one CAS lease and sanitized environment', async (t) => {
  const f = await fixture(t);
  const planned = await f.backend.plan(f.root, {
    remote: 'origin',
    sourceOid: SOURCE,
    destinationRef: DEST,
  });
  const record: RemoteGitPushRecord = {
    pushId: 'push_fixture',
    ownerId: 'owner',
    sessionId: 'session',
    adapterId: 'adapter',
    workspaceId: 'workspace',
    workspaceRoot: f.root,
    repositoryIdentity: planned.repositoryIdentity,
    remoteDisplayName: 'origin',
    resolvedPushUrl: planned.resolvedPushUrl,
    sourceOid: SOURCE,
    destinationRef: DEST,
    expectedRemoteState: { kind: 'OID', oid: OLD },
    commitSubject: planned.commitSubject,
    changedFilesSummary: planned.changedFilesSummary,
    aheadCommitCount: 2,
    requestFingerprint: '1'.repeat(64),
    grantFingerprint: '2'.repeat(64),
    state: 'ACTIVE',
    createdAt: 1,
    reviewDeadline: 2,
    approvedAt: 3,
    expiresAt: 9_999_999,
    maxUses: 1,
    useCount: 1,
    executionStartedAt: 4,
  };

  const outcome = await f.backend.execute(record);
  assert.deepEqual(outcome, { outcome: 'SUCCEEDED', observedRemoteOid: SOURCE });

  const push = f.runner.calls.find((call) => call.args.includes('push'));
  assert.ok(push);
  const pushIndex = push.args.indexOf('push');
  const pushArgs = push.args.slice(pushIndex + 1);
  assert.equal(pushArgs.includes('--no-verify'), true);
  assert.equal(pushArgs.includes('--porcelain'), true);
  assert.equal(pushArgs.includes('--force-with-lease=' + DEST + ':' + OLD), true);
  assert.equal(pushArgs.includes(URL), true);
  assert.equal(pushArgs.includes(SOURCE + ':' + DEST), true);
  assert.equal(pushArgs.includes('origin'), false, 'effect must use verified URL, never remote name');
  assert.equal(
    push.args.includes('core.hooksPath=' + resolve(f.hooksDir)),
    true,
  );

  assert.equal(push.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(push.env.SECRET_TOKEN, undefined);
  assert.equal(push.env.GIT_CONFIG_COUNT, undefined);
  assert.notEqual(push.env.GIT_SSH_COMMAND, 'attacker-controlled');
  assert.match(push.env.GIT_SSH_COMMAND ?? '', /^ssh -F /);
});

test('pre-effect remote drift refuses the push and never executes a remote mutation', async (t) => {
  const f = await fixture(t);
  const planned = await f.backend.plan(f.root, {
    remote: 'origin',
    sourceOid: SOURCE,
    destinationRef: DEST,
  });
  f.runner.remoteOid = OTHER;

  const record: RemoteGitPushRecord = {
    pushId: 'push_drift',
    ownerId: 'owner',
    sessionId: 'session',
    adapterId: 'adapter',
    workspaceId: 'workspace',
    workspaceRoot: f.root,
    repositoryIdentity: planned.repositoryIdentity,
    remoteDisplayName: 'origin',
    resolvedPushUrl: planned.resolvedPushUrl,
    sourceOid: SOURCE,
    destinationRef: DEST,
    expectedRemoteState: { kind: 'OID', oid: OLD },
    commitSubject: planned.commitSubject,
    changedFilesSummary: planned.changedFilesSummary,
    requestFingerprint: '3'.repeat(64),
    grantFingerprint: '4'.repeat(64),
    state: 'ACTIVE',
    createdAt: 1,
    reviewDeadline: 2,
    approvedAt: 3,
    expiresAt: 9_999_999,
    maxUses: 1,
    useCount: 1,
    executionStartedAt: 4,
  };

  const outcome = await f.backend.execute(record);
  assert.equal(outcome.outcome, 'NOT_OBSERVED');
  assert.equal(outcome.observedRemoteOid, OTHER);
  assert.equal(f.runner.calls.some((call) => call.args.includes('push')), false);
});


test('ABSENT branch creation uses an empty exact force-with-lease CAS', async (t) => {
  const runner = new FakeRunner();
  runner.remoteOid = undefined;
  const f = await fixture(t, runner);
  const planned = await f.backend.plan(f.root, {
    remote: 'origin',
    sourceOid: SOURCE,
    destinationRef: DEST,
  });
  assert.deepEqual(planned.expectedRemoteState, { kind: 'ABSENT' });

  const record: RemoteGitPushRecord = {
    pushId: 'push_absent',
    ownerId: 'owner',
    sessionId: 'session',
    adapterId: 'adapter',
    workspaceId: 'workspace',
    workspaceRoot: f.root,
    repositoryIdentity: planned.repositoryIdentity,
    remoteDisplayName: 'origin',
    resolvedPushUrl: planned.resolvedPushUrl,
    sourceOid: SOURCE,
    destinationRef: DEST,
    expectedRemoteState: { kind: 'ABSENT' },
    commitSubject: planned.commitSubject,
    changedFilesSummary: planned.changedFilesSummary,
    requestFingerprint: '5'.repeat(64),
    grantFingerprint: '6'.repeat(64),
    state: 'ACTIVE',
    createdAt: 1,
    reviewDeadline: 2,
    approvedAt: 3,
    expiresAt: 9_999_999,
    maxUses: 1,
    useCount: 1,
    executionStartedAt: 4,
  };

  const outcome = await f.backend.execute(record);
  assert.deepEqual(outcome, { outcome: 'SUCCEEDED', observedRemoteOid: SOURCE });
  const push = runner.calls.find((call) => call.args.includes('push'));
  assert.ok(push);
  assert.equal(push.args.includes('--force-with-lease=' + DEST + ':'), true);
});

test('an ABSENT grant refuses execution if the destination appears before effect', async (t) => {
  const runner = new FakeRunner();
  runner.remoteOid = undefined;
  const f = await fixture(t, runner);
  const planned = await f.backend.plan(f.root, {
    remote: 'origin',
    sourceOid: SOURCE,
    destinationRef: DEST,
  });
  runner.remoteOid = OTHER;

  const record: RemoteGitPushRecord = {
    pushId: 'push_absent_race',
    ownerId: 'owner',
    sessionId: 'session',
    adapterId: 'adapter',
    workspaceId: 'workspace',
    workspaceRoot: f.root,
    repositoryIdentity: planned.repositoryIdentity,
    remoteDisplayName: 'origin',
    resolvedPushUrl: planned.resolvedPushUrl,
    sourceOid: SOURCE,
    destinationRef: DEST,
    expectedRemoteState: { kind: 'ABSENT' },
    commitSubject: planned.commitSubject,
    changedFilesSummary: planned.changedFilesSummary,
    requestFingerprint: '7'.repeat(64),
    grantFingerprint: '8'.repeat(64),
    state: 'ACTIVE',
    createdAt: 1,
    reviewDeadline: 2,
    approvedAt: 3,
    expiresAt: 9_999_999,
    maxUses: 1,
    useCount: 1,
    executionStartedAt: 4,
  };

  const outcome = await f.backend.execute(record);
  assert.equal(outcome.outcome, 'NOT_OBSERVED');
  assert.equal(outcome.observedRemoteOid, OTHER);
  assert.equal(runner.calls.some((call) => call.args.includes('push')), false);
});

test('effective push URL drift after review refuses the effect and never uses the remote name', async (t) => {
  const runner = new FakeRunner();
  const f = await fixture(t, runner);
  const planned = await f.backend.plan(f.root, {
    remote: 'origin',
    sourceOid: SOURCE,
    destinationRef: DEST,
  });
  runner.remoteUrl = 'https://github.com/example/other.git';

  const record: RemoteGitPushRecord = {
    pushId: 'push_url_drift',
    ownerId: 'owner',
    sessionId: 'session',
    adapterId: 'adapter',
    workspaceId: 'workspace',
    workspaceRoot: f.root,
    repositoryIdentity: planned.repositoryIdentity,
    remoteDisplayName: 'origin',
    resolvedPushUrl: planned.resolvedPushUrl,
    sourceOid: SOURCE,
    destinationRef: DEST,
    expectedRemoteState: { kind: 'OID', oid: OLD },
    commitSubject: planned.commitSubject,
    changedFilesSummary: planned.changedFilesSummary,
    requestFingerprint: '9'.repeat(64),
    grantFingerprint: '0'.repeat(64),
    state: 'ACTIVE',
    createdAt: 1,
    reviewDeadline: 2,
    approvedAt: 3,
    expiresAt: 9_999_999,
    maxUses: 1,
    useCount: 1,
    executionStartedAt: 4,
  };

  const outcome = await f.backend.execute(record);
  assert.equal(outcome.outcome, 'NOT_OBSERVED');
  assert.equal(outcome.errorClass, 'REMOTE_IDENTITY_DRIFT');
  assert.equal(runner.calls.some((call) => call.args.includes('push')), false);
});

test('WAG-owned hooks directory must be empty before any remote observation', async (t) => {
  const f = await fixture(t);
  await mkdir(f.hooksDir, { recursive: true });
  await writeFile(join(f.hooksDir, 'pre-push'), 'attacker residue\n', 'utf8');

  await assert.rejects(
    f.backend.plan(f.root, {
      remote: 'origin',
      sourceOid: SOURCE,
      destinationRef: DEST,
    }),
    /hooks directory must be empty/i,
  );
  assert.equal(f.runner.calls.some((call) => call.args.includes('ls-remote')), false);
});

test('WAG-owned empty hooks directory must remain outside the target repository', async (t) => {
  const f = await fixture(t);
  const inside = new LocalRemoteGitPushBackend({
    hooksDir: join(f.root, '.wag-hooks-inside'),
    runner: f.runner.run,
    parentEnv: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
  });

  await assert.rejects(
    inside.plan(f.root, {
      remote: 'origin',
      sourceOid: SOURCE,
      destinationRef: DEST,
    }),
    /hooks directory inside repository/i,
  );
});


test('Git push hardening suppresses a repository pre-push hook while updating only the exact feature ref', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'wag-remote-push-hook-semantics-'));
  const repo = join(base, 'repo');
  const bare = join(base, 'remote.git');
  const ownedHooks = join(base, 'wag-owned-hooks');
  const canary = join(base, 'pre-push-hook-ran.txt');
  t.after(() => rm(base, { recursive: true, force: true }));

  await execFileAsync('git', ['init', '--quiet', repo]);
  await execFileAsync('git', ['init', '--bare', '--quiet', bare]);
  await mkdir(ownedHooks, { recursive: true });
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'WAG Test']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'wag-test@example.invalid']);
  await writeFile(join(repo, 'fixture.txt'), 'bounded push\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', '--', 'fixture.txt']);
  await execFileAsync('git', ['-C', repo, 'commit', '--quiet', '-m', 'feat: hook suppression fixture']);

  const gitDir = (await execFileAsync('git', ['-C', repo, 'rev-parse', '--git-dir'], { encoding: 'utf8' }))
    .stdout.trim();
  const hookPath = join(repo, gitDir, 'hooks', 'pre-push');
  await mkdir(join(repo, gitDir, 'hooks'), { recursive: true });
  const canaryShellPath = canary.replace(/\\/g, '/').replace(/'/g, "'\\''");
  await writeFile(
    hookPath,
    "#!/bin/sh\nprintf 'ran' > '" + canaryShellPath + "'\nexit 1\n",
    { encoding: 'utf8', mode: 0o755 },
  );
  await chmod(hookPath, 0o755);

  const source = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }))
    .stdout.trim();
  const destination = 'refs/heads/feat/hook-suppression';
  await execFileAsync('git', [
    '-C', repo,
    '-c', 'core.hooksPath=' + ownedHooks,
    'push',
    '--no-verify',
    pathToFileURL(bare).href,
    source + ':' + destination,
  ]);

  const observed = (await execFileAsync(
    'git',
    ['--git-dir=' + bare, 'rev-parse', destination],
    { encoding: 'utf8' },
  )).stdout.trim();
  assert.equal(observed, source);
  await assert.rejects(readFile(canary, 'utf8'), /ENOENT/);
});
