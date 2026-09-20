import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  ALLOWED_BASE_ENV_KEYS,
  NEUTRALIZED_GIT_CONFIG_KEYS,
  REMOVED_GIT_ENV_KEYS,
  REMOVED_GIT_ENV_PREFIXES,
  SAFE_GIT_BASE_ARGS,
  SAFE_GIT_GLOBAL_FLAGS,
  SAFE_GIT_RUNNER_SOURCE,
  buildSafeGitEnv,
  driverOverrideEnv,
  isRemovedGitEnvKey,
  parseConfigHookNames,
  parseFilterDriverNames,
} from '../src/safe-git.js';

const execFileAsync = promisify(execFile);

/**
 * Runs git exactly as the policy says to, from this process. The in-backend helper is generated
 * from the same constants, so driving the policy directly here is what makes the adversarial
 * matrix below affordable: every case is a real git process against a real hostile repository,
 * without a round trip through the execution backend.
 */
async function safeGit(cwd: string, args: string[], overrides: Record<string, string> = {}) {
  const env = buildSafeGitEnv(process.env, overrides);
  // The embedded runner resolves these once per process; the in-process mirror resolves them
  // per call so a test can change the repository's filters between assertions.
  const listing = await execFileAsync(
    'git', [...SAFE_GIT_BASE_ARGS, 'config', '--name-only', '--get-regexp', '^(filter|hook)\\.'],
    { cwd, env, encoding: 'utf8' },
  ).catch(() => ({ stdout: '' }));
  const suppression = driverOverrideEnv(
    parseFilterDriverNames(listing.stdout),
    parseConfigHookNames(listing.stdout),
  );
  return execFileAsync('git', [...SAFE_GIT_BASE_ARGS, ...args], {
    cwd, env: { ...env, ...suppression }, encoding: 'utf8',
  });
}

/** The same commands with no policy at all, so each canary is proven to be armed. */
async function plainGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return execFileAsync('git', args, { cwd, env, encoding: 'utf8' });
}

interface Fixture { root: string; canaryDir: string; canary: string; hooksDir: string; script: string }

/**
 * A repository that is hostile in every way the policy must survive: hooks in both locations,
 * an executable configured for every config key that takes a command, and attributes that ask
 * git to transform content on the way in.
 */
async function hostileRepository(t: test.TestContext): Promise<Fixture> {
  const canaryDir = await mkdtemp(join(tmpdir(), 'wag-safegit-'));
  t.after(() => rm(canaryDir, { recursive: true, force: true }));
  const root = join(canaryDir, 'repo');
  const hooksDir = join(canaryDir, 'evil-hooks');
  const canary = join(canaryDir, 'canary.txt');
  const script = join(canaryDir, 'fire.sh');
  const posix = (value: string) => value.replace(/\\/g, '/');

  await mkdir(root, { recursive: true });
  await mkdir(hooksDir, { recursive: true });
  await writeFile(script, `#!/bin/sh\necho FIRED >> ${posix(canary)}\nexit 0\n`);
  await chmod(script, 0o755);

  await plainGit(root, ['init', '--quiet', '--initial-branch=work', '.']);
  await plainGit(root, ['config', 'user.email', 'wag@example.invalid']);
  await plainGit(root, ['config', 'user.name', 'WAG Test']);
  await writeFile(join(root, 'tracked.txt'), 'original\n');
  await plainGit(root, ['add', '-A']);
  await plainGit(root, ['-c', `core.hooksPath=${posix(hooksDir)}x`, 'commit', '--quiet', '-m', 'base']);

  // Hooks last, so the fixture's own porcelain never arms the canary.
  for (const hook of [
    'pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-index-change',
    'reference-transaction', 'pre-applypatch', 'post-checkout', 'post-rewrite', 'pre-auto-gc',
    'push-to-checkout', 'fsmonitor-watchman',
  ]) {
    for (const location of [join(root, '.git', 'hooks'), hooksDir]) {
      const file = join(location, hook);
      await writeFile(file, `#!/bin/sh\necho FIRED-${hook} >> ${posix(canary)}\nexit 0\n`);
      await chmod(file, 0o755);
    }
  }

  // Every repository-settable key whose value git treats as a command line.
  for (const [key, value] of [
    ['core.hooksPath', posix(hooksDir)],
    ['core.fsmonitor', posix(script)],
    ['core.pager', posix(script)],
    ['core.editor', posix(script)],
    ['core.askPass', posix(script)],
    ['core.sshCommand', posix(script)],
    ['diff.external', posix(script)],
    ['diff.evil.textconv', posix(script)],
    ['diff.evil.command', posix(script)],
    ['filter.evil.clean', posix(script)],
    ['filter.evil.smudge', posix(script)],
    ['gpg.program', posix(script)],
    ['credential.helper', posix(script)],
    ['sequence.editor', posix(script)],
    ['commit.gpgsign', 'true'],
    // Config-defined hooks, Git 2.53 and later. These are a second, independent hook mechanism:
    // core.hooksPath does not touch them, and they fire from the repository's own config for
    // plumbing events like reference-transaction as readily as for pre-commit.
    ['hook.evil.command', posix(script)],
    ['hook.evil.event', 'reference-transaction'],
    ['hook.evil2.command', posix(script)],
    ['hook.evil2.event', 'pre-commit'],
    ['hook.evil3.command', posix(script)],
    ['hook.evil3.event', 'post-index-change'],
  ] as const) {
    await plainGit(root, ['config', key, value]);
  }

  return { root, canaryDir, canary, hooksDir, script };
}

async function fired(canary: string): Promise<string> {
  return (await readFile(canary, 'utf8').catch(() => '')).trim();
}

test('the policy neutralizes every git config key that names a program', () => {
  for (const key of [
    'core.fsmonitor', 'core.pager', 'core.editor', 'core.askPass', 'core.sshCommand',
    'diff.external', 'gpg.program', 'credential.helper', 'sequence.editor',
  ]) {
    assert.ok(
      NEUTRALIZED_GIT_CONFIG_KEYS.some((setting) => setting.startsWith(`${key}=`)),
      `${key} must be overridden on every invocation`,
    );
  }
  // core.hooksPath is deliberately absent here: an empty value falls back to .git/hooks, which
  // is the attacker's directory. It is set per-invocation to a directory the runner owns.
  assert.equal(NEUTRALIZED_GIT_CONFIG_KEYS.some((s) => s.startsWith('core.hooksPath')), false);

  for (const flag of ['--no-optional-locks', '--literal-pathspecs', '-P']) {
    assert.ok(SAFE_GIT_GLOBAL_FLAGS.includes(flag), `${flag} must be a global flag`);
  }
  assert.deepEqual(
    SAFE_GIT_BASE_ARGS.slice(0, SAFE_GIT_GLOBAL_FLAGS.length),
    SAFE_GIT_GLOBAL_FLAGS,
    'global flags come before any -c so a later -c cannot displace them',
  );
});

test('the child environment is built up from an allowlist, never inherited', () => {
  const parent: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
  for (const key of REMOVED_GIT_ENV_KEYS) parent[key] = 'hostile';
  for (const prefix of REMOVED_GIT_ENV_PREFIXES) parent[`${prefix}0`] = 'hostile';
  parent.DEVSPACE_OAUTH_OWNER_TOKEN = 'secret';
  parent.AWS_SECRET_ACCESS_KEY = 'secret';
  parent.WAG_OPERATOR_COOKIE = 'secret';

  const env = buildSafeGitEnv(parent);

  for (const key of REMOVED_GIT_ENV_KEYS) {
    // Both askpass variables are deliberately re-added as empty, which is not inheritance.
    if (key === 'GIT_ASKPASS' || key === 'SSH_ASKPASS') continue;
    assert.equal(env[key], undefined, `${key} must not reach a git child`);
  }
  for (const prefix of REMOVED_GIT_ENV_PREFIXES) {
    assert.equal(env[`${prefix}0`], undefined, `${prefix}* must not reach a git child`);
  }
  for (const secret of ['DEVSPACE_OAUTH_OWNER_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'WAG_OPERATOR_COOKIE']) {
    assert.equal(secret in env, false, `${secret} must not reach a git child`);
  }
  assert.equal(env.PATH, '/usr/bin', 'git must still be findable');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_ASKPASS, '');

  // Nothing outside the allowlist survives, whatever a future caller puts in the parent.
  for (const key of Object.keys(env)) {
    const wagOwned = ['GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'SSH_ASKPASS'].includes(key);
    assert.ok(wagOwned || ALLOWED_BASE_ENV_KEYS.includes(key), `${key} is not in the allowlist`);
  }
});

test('only WAG-owned GIT_ values may be reintroduced, and they win', () => {
  const env = buildSafeGitEnv({ PATH: '/usr/bin', GIT_INDEX_FILE: '/hostile/index' }, {
    GIT_INDEX_FILE: '/wag/index',
    GIT_OBJECT_DIRECTORY: '/wag/objects',
  });
  assert.equal(env.GIT_INDEX_FILE, '/wag/index');
  assert.equal(env.GIT_OBJECT_DIRECTORY, '/wag/objects');
  assert.throws(() => buildSafeGitEnv({}, { PATH: '/evil' }), /must be a GIT_ variable/);
});

test('isRemovedGitEnvKey covers the numbered config-injection variables', () => {
  for (const key of ['GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_17', 'GIT_TRACE', 'GIT_TRACE2_EVENT', 'GIT_DIR']) {
    assert.equal(isRemovedGitEnvKey(key), true, `${key} must be treated as removed`);
  }
  for (const key of ['PATH', 'HOME', 'GITHUB_TOKEN_UNRELATED']) {
    assert.equal(isRemovedGitEnvKey(key), false, `${key} is not a git routing variable`);
  }
});

test('the emitted runner source carries the same policy and no shell syntax', () => {
  for (const flag of SAFE_GIT_GLOBAL_FLAGS) {
    assert.ok(SAFE_GIT_RUNNER_SOURCE.includes(JSON.stringify(flag).slice(1, -1)), `${flag} missing from the helper`);
  }
  assert.ok(SAFE_GIT_RUNNER_SOURCE.includes('core.hooksPath'), 'the helper must pin core.hooksPath');
  assert.ok(SAFE_GIT_RUNNER_SOURCE.includes('GIT_TERMINAL_PROMPT'), 'the helper must disable prompting');
  assert.equal(SAFE_GIT_RUNNER_SOURCE.includes('`'), false, 'a backtick would terminate the embedding literal');
  assert.equal(/execSync|shell\s*:\s*true|\bexec\(['"`]/.test(SAFE_GIT_RUNNER_SOURCE), false,
    'the helper must never reach a shell');
});

test('a hostile repository cannot execute anything through the policy', async (t) => {
  const { root, canary } = await hostileRepository(t);
  await writeFile(join(root, 'tracked.txt'), 'changed\n');
  await writeFile(join(root, '.gitattributes'), 'tracked.txt diff=evil filter=evil text=auto\n');

  const hooks = await mkdtemp(join(tmpdir(), 'wag-nohooks-'));
  t.after(() => rm(hooks, { recursive: true, force: true }));
  const pinned = ['-c', `core.hooksPath=${hooks.replace(/\\/g, '/')}`];

  // Every read-shaped command WAG issues, under the full policy, against the hostile repository.
  for (const args of [
    ['status', '--short', '--branch', '--ignore-submodules=all'],
    ['rev-parse', 'HEAD'],
    ['rev-parse', '--show-toplevel'],
    ['rev-parse', '--absolute-git-dir'],
    ['symbolic-ref', '--quiet', 'HEAD'],
    ['var', 'GIT_AUTHOR_IDENT'],
    ['ls-files', '-z'],
    ['ls-files', '-z', '--others', '--exclude-standard'],
    ['grep', '-F', '-n', '-I', '-C1', '-z', '--no-textconv', '--', 'changed'],
    ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', 'HEAD', '--', '.'],
    ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--stat', '--', '.'],
    ['check-attr', 'filter', '--', 'tracked.txt'],
    ['ls-tree', 'HEAD', '--', 'tracked.txt'],
    ['hash-object', '--no-filters', '-t', 'blob', '--', 'tracked.txt'],
    ['diff-tree', '--name-status', '--no-renames', '-r', '-z', 'HEAD', 'HEAD'],
  ]) {
    await rm(canary, { force: true });
    await safeGit(root, [...pinned, ...args]).catch(() => undefined);
    assert.equal(await fired(canary), '', `${args[0]} executed something: ${await fired(canary)}`);
  }
});

test('a content filter cannot execute through a diff', async (t) => {
  const { root, canary, script } = await hostileRepository(t);
  await writeFile(join(root, '.gitattributes'), 'tracked.txt filter=evil\n');
  await writeFile(join(root, 'tracked.txt'), 'changed\n');
  const hooks = await mkdtemp(join(tmpdir(), 'wag-nohooks-'));
  t.after(() => rm(hooks, { recursive: true, force: true }));
  const pinned = ['-c', `core.hooksPath=${hooks.replace(/\\/g, '/')}`];

  // Control: --no-ext-diff and --no-textconv are not enough. The clean filter still runs.
  await rm(canary, { force: true });
  await plainGit(root, [
    '-c', `core.hooksPath=${hooks.replace(/\\/g, '/')}`,
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', '.',
  ]).catch(() => undefined);
  assert.notEqual(await fired(canary), '',
    'control: a clean filter really does execute during diff despite the diff flags');

  // Under the policy the driver is enumerated from config and overridden to empty.
  await rm(canary, { force: true });
  const diff = await safeGit(root, [...pinned, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', '.']);
  assert.equal(await fired(canary), '', 'no filter may execute through the policy');
  assert.match(diff.stdout, /^\+changed$/m, 'and the diff must still be correct');
  assert.equal(diff.stdout.includes(script), false, 'the driver path must not leak into the diff');
});

test('filter driver enumeration is exact and bounded', () => {
  assert.deepEqual(
    parseFilterDriverNames([
      'filter.lfs.clean', 'filter.lfs.smudge', 'filter.lfs.process', 'filter.lfs.required',
      'filter.evil.clean', 'filter.dotted.name.clean', 'core.hooksPath', '',
    ].join('\n')).sort(),
    ['dotted.name', 'evil', 'lfs'],
  );
  assert.deepEqual(driverOverrideEnv(['evil'], []), {
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'filter.evil.clean', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'filter.evil.smudge', GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'filter.evil.process', GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: 'filter.evil.required', GIT_CONFIG_VALUE_3: 'false',
  });
  // The key and the value are separate variables, so a name containing = cannot escape.
  assert.equal(driverOverrideEnv(['a=b'], []).GIT_CONFIG_KEY_0, 'filter.a=b.clean');
  assert.deepEqual(
    parseConfigHookNames(['hook.evil.command', 'hook.evil.event', 'hook.two.enabled', 'filter.x.clean'].join('\n')).sort(),
    ['evil', 'two'],
  );
  // Two names an independent review found escaping the previous -c-based suppression: one
  // because git splits -c on the first =, one because assigning it onto a plain object creates
  // no own property and Object.keys silently dropped it.
  assert.deepEqual(parseFilterDriverNames('filter.a=b.clean'), ['a=b']);
  assert.deepEqual(parseFilterDriverNames('filter.__proto__.clean'), ['__proto__']);
  assert.deepEqual(parseConfigHookNames('hook.__proto__.command'), ['__proto__']);
  assert.equal(driverOverrideEnv(['__proto__'], []).GIT_CONFIG_KEY_0, 'filter.__proto__.clean');
  assert.deepEqual(driverOverrideEnv([], ['evil']), {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'hook.evil.command', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'hook.evil.enabled', GIT_CONFIG_VALUE_1: 'false',
  });
  assert.throws(() => driverOverrideEnv(Array.from({ length: 65 }, (_, i) => `d${i}`), []),
    /TOO_MANY_CONFIGURED_DRIVERS/);
});

test('the canaries are real: without the policy the same repository executes', async (t) => {
  const { root, canary, script } = await hostileRepository(t);
  await writeFile(join(root, 'tracked.txt'), 'changed\n');
  await writeFile(join(root, '.gitattributes'), 'tracked.txt diff=evil filter=evil\n');

  // diff.external, via repository config, with no --no-ext-diff.
  await rm(canary, { force: true });
  await plainGit(root, ['diff', '--no-color', 'HEAD', '--', '.']).catch(() => undefined);
  assert.notEqual(await fired(canary), '', 'diff.external canary is not armed');

  // A hook, via the repository's own core.hooksPath.
  await rm(canary, { force: true });
  await plainGit(root, ['add', '--', 'tracked.txt']).catch(() => undefined);
  const afterAdd = await fired(canary);
  assert.ok(afterAdd.includes('FIRED'), `clean filter or hook canary is not armed: ${afterAdd}`);

  // GIT_EXTERNAL_DIFF, via the inherited environment.
  await rm(canary, { force: true });
  await plainGit(root, ['diff', '--no-color', 'HEAD', '--', '.'], {
    ...process.env, GIT_EXTERNAL_DIFF: script,
  }).catch(() => undefined);
  assert.notEqual(await fired(canary), '', 'GIT_EXTERNAL_DIFF canary is not armed');
});

test('a hostile inherited environment cannot redirect or inject', async (t) => {
  const { root, canary, hooksDir, script } = await hostileRepository(t);
  const other = join(await mkdtemp(join(tmpdir(), 'wag-other-')), 'other');
  t.after(() => rm(other, { recursive: true, force: true }));
  await mkdir(other, { recursive: true });
  await plainGit(other, ['init', '--quiet', '--initial-branch=main', '.']);

  const hostile: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: join(other, '.git'),
    GIT_WORK_TREE: other,
    GIT_INDEX_FILE: join(other, 'hostile-index'),
    GIT_OBJECT_DIRECTORY: join(other, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(other, 'objects'),
    GIT_EXTERNAL_DIFF: script,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksDir,
    GIT_AUTHOR_NAME: 'Somebody Else',
    GIT_AUTHOR_EMAIL: 'else@example.invalid',
  };

  // The policy builds the child environment from the allowlist, so none of the above is present.
  const env = buildSafeGitEnv(hostile);
  const withPolicy = await execFileAsync('git', [...SAFE_GIT_BASE_ARGS, 'rev-parse', '--absolute-git-dir'], {
    cwd: root, env, encoding: 'utf8',
  });
  assert.match(withPolicy.stdout.trim(), /repo\/\.git$/, 'the admitted repository must be the one git uses');

  const ident = await execFileAsync('git', [...SAFE_GIT_BASE_ARGS, 'var', 'GIT_AUTHOR_IDENT'], {
    cwd: root, env, encoding: 'utf8',
  });
  assert.match(ident.stdout, /WAG Test <wag@example\.invalid>/,
    'the author must come from the reviewed repository, not the environment');

  // Without the policy the same environment retargets git entirely — the reason it exists.
  // The control needs only the two routing variables. Pointing the object directory somewhere
  // that does not exist makes git refuse for an unrelated reason and would prove nothing.
  const withoutPolicy = await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: root,
    env: { ...process.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other },
    encoding: 'utf8',
  });
  assert.match(withoutPolicy.stdout.trim(), /other\/\.git$/,
    'control: an inherited GIT_DIR really does redirect git');
  assert.equal(await fired(canary), '');
});

test('--literal-pathspecs makes an awkward filename mean itself', async (t) => {
  const { root } = await hostileRepository(t);
  for (const name of ['with space.txt', '-leading-dash.txt', 'bracket[1].txt', "quote'single.txt", 'comma,name.txt']) {
    await writeFile(join(root, name), `content of ${name}\n`);
  }
  await writeFile(join(root, 'decoy1.txt'), 'decoy\n');

  const hooks = await mkdtemp(join(tmpdir(), 'wag-nohooks-'));
  t.after(() => rm(hooks, { recursive: true, force: true }));
  const pinned = ['-c', `core.hooksPath=${hooks.replace(/\\/g, '/')}`];

  // A bracket expression would otherwise be a glob: under the policy it matches only itself.
  const listed = await safeGit(root, [...pinned, 'ls-files', '--others', '--exclude-standard', '-z', '--', 'bracket[1].txt']);
  assert.deepEqual(listed.stdout.split('\0').filter(Boolean), ['bracket[1].txt']);

  // A path that is pathspec magic without the flag is an ordinary relative path with it.
  const dashed = await safeGit(root, [...pinned, 'ls-files', '--others', '--exclude-standard', '-z', '--', '-leading-dash.txt']);
  assert.deepEqual(dashed.stdout.split('\0').filter(Boolean), ['-leading-dash.txt']);
});

/**
 * Config-defined hooks are a second hook mechanism, independent of the hooks directory. Git 2.53
 * added them, `core.hooksPath` does nothing to them, and they are honoured from the repository's
 * own `.git/config` — which means the hook defence accepted in ADR-0023 did not cover them.
 */
test('a config-defined hook cannot execute through the policy', async (t) => {
  const { root, canary } = await hostileRepository(t);
  const hooks = await mkdtemp(join(tmpdir(), 'wag-nohooks-'));
  t.after(() => rm(hooks, { recursive: true, force: true }));
  const pinned = ['-c', `core.hooksPath=${hooks.replace(/\\/g, '/')}`];

  // Control: pinning the hooks directory — the whole of the previous defence — changes nothing.
  await rm(canary, { force: true });
  await plainGit(root, [...pinned, 'update-ref', 'refs/heads/control', 'HEAD']).catch(() => undefined);
  assert.match(await fired(canary), /FIRED/,
    'control: a config-defined hook really does survive core.hooksPath');

  // Under the policy every configured hook name is enumerated and overridden.
  await rm(canary, { force: true });
  await safeGit(root, [...pinned, 'update-ref', 'refs/heads/probe', 'HEAD']);
  assert.equal(await fired(canary), '', 'no config-defined hook may execute');

  const moved = await safeGit(root, [...pinned, 'rev-parse', 'refs/heads/probe']);
  assert.match(moved.stdout.trim(), /^[0-9a-f]{40}$/, 'and the ref update must still have happened');
});

/**
 * Two driver names an independent review found escaping the previous suppression, both of which
 * are arbitrary command execution when they escape: `a=b`, because git splits a `-c` argument on
 * the first `=` and the override landed on a different key entirely; and `__proto__`, because
 * assigning it onto a plain object creates no own property, so the enumeration dropped it.
 */
test('a driver name chosen to escape the override still cannot execute', async (t) => {
  for (const name of ['a=b', '__proto__']) {
    const { root, canary, script } = await hostileRepository(t);
    const posix = (value: string) => value.replace(/\\/g, '/');
    await plainGit(root, ['config', `filter.${name}.clean`, posix(script)]);
    await plainGit(root, ['config', `hook.${name}.command`, posix(script)]);
    await plainGit(root, ['config', `hook.${name}.event`, 'reference-transaction']);
    await writeFile(join(root, '.gitattributes'), `tracked.txt filter=${name}\n`);
    await writeFile(join(root, 'tracked.txt'), 'changed\n');

    const hooks = await mkdtemp(join(tmpdir(), 'wag-nohooks-'));
    t.after(() => rm(hooks, { recursive: true, force: true }));
    const pinned = ['-c', `core.hooksPath=${hooks.replace(/\\/g, '/')}`];

    // Control: the repository really does get execution without the policy.
    await rm(canary, { force: true });
    await plainGit(root, [...pinned, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.'])
      .catch(() => undefined);
    assert.notEqual(await fired(canary), '', `control: driver ${name} is not armed`);

    await rm(canary, { force: true });
    await safeGit(root, [...pinned, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.']);
    assert.equal(await fired(canary), '', `a filter named ${name} must not execute`);

    await rm(canary, { force: true });
    await safeGit(root, [...pinned, 'update-ref', 'refs/heads/probe', 'HEAD']);
    assert.equal(await fired(canary), '', `a config hook named ${name} must not execute`);
  }
});

/**
 * The policy has two renderings — this module's exports, and the JavaScript fragment embedded in
 * the helpers that run inside the execution backend. The adversarial matrix above drives the
 * first. This drives the second, because a difference between them is exactly how a `__proto__`
 * driver stayed live while the mirror handled it correctly.
 */
test('the emitted runner suppresses the same drivers as the exported policy', async (t) => {
  const { root, canary, script } = await hostileRepository(t);
  const posix = (value: string) => value.replace(/\\/g, '/');
  for (const name of ['a=b', '__proto__', 'plain']) {
    await plainGit(root, ['config', `filter.${name}.clean`, posix(script)]);
    await plainGit(root, ['config', `hook.${name}.command`, posix(script)]);
    await plainGit(root, ['config', `hook.${name}.event`, 'reference-transaction']);
  }
  await writeFile(join(root, '.gitattributes'), 'tracked.txt filter=a=b\n');
  await writeFile(join(root, 'tracked.txt'), 'changed\n');

  const scratch = await mkdtemp(join(tmpdir(), 'wag-runner-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const program = join(scratch, 'runner.js');
  await writeFile(program, [
    SAFE_GIT_RUNNER_SOURCE,
    "try {",
    "  gitOk(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.']);",
    "  gitOk(['update-ref', 'refs/heads/runner-probe', 'HEAD']);",
    "  process.stdout.write('OK');",
    "} finally { disposeGitRunner(); }",
  ].join('\n'));

  await rm(canary, { force: true });
  const { stdout } = await execFileAsync(process.execPath, [program], { cwd: root, encoding: 'utf8' });
  assert.equal(stdout, 'OK', 'the emitted runner must complete both operations');
  assert.equal(await fired(canary), '',
    'the emitted runner must suppress every driver the exported policy suppresses');
});

/**
 * Every helper is a JavaScript program living inside a TypeScript template literal, so the
 * template consumes one level of escaping on the way out. A single backslash that should have
 * been two turns `\u0000` into a raw control character and `/\s+/` into `/s+/` — the second of
 * those produced a wrong result that looked like a legitimate refusal.
 *
 * This drives the real command assembly rather than the source text, decodes what would actually
 * be sent, and parses it. A helper that does not parse can never reach production.
 */
test('every helper reaches the wire as valid JavaScript', async (t) => {
  const { gunzipSync } = await import('node:zlib');
  const scratch = await mkdtemp(join(tmpdir(), 'wag-wire-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const commands: string[] = [];
  const stub = {
    openWorkspace: async () => 'ws',
    execCommand: async (_id: string, cmd: string) => {
      commands.push(cmd);
      return { output: '', exitCode: 1, running: false };
    },
    interruptCommand: async () => {},
  };

  const { DevspaceRepositoryInspectionBackend } = await import('../src/repository-inspection.js');
  const { DevspaceGitCommitBackend } = await import('../src/executor/devspace-git-commit.js');
  const inspection = new DevspaceRepositoryInspectionBackend(stub as never);
  const commit = new DevspaceGitCommitBackend(stub as never);

  await inspection.snapshot('ws', 'C:/root').catch(() => undefined);
  await inspection.list('ws', 'C:/root').catch(() => undefined);
  await inspection.diff('ws', 'C:/root').catch(() => undefined);
  await inspection.search({
    devspaceWorkspaceId: 'ws', canonicalRoot: 'C:/root',
    query: 'q', ignoreCase: false, maxResults: 20, contextLines: 1,
  }).catch(() => undefined);
  await commit.plan('C:/root', ['f.txt'], 'm\n').catch(() => undefined);

  assert.equal(commands.length, 5, 'all five helpers must have been assembled');
  for (const [index, command] of commands.entries()) {
    assert.ok(command.length <= 8000, `helper ${index} must fit the cmd.exe command line`);
    const encoded = command.split(' ')[3];
    assert.ok(encoded, `helper ${index} must carry an encoded program`);
    const program = gunzipSync(Buffer.from(encoded, 'base64url')).toString('utf8');
    const file = join(scratch, `helper-${index}.js`);
    await writeFile(file, program);
    await execFileAsync(process.execPath, ['--check', file], { encoding: 'utf8' });

    // The envelope is base64url throughout, so nothing in it can be shell syntax.
    assert.match(command.slice(command.indexOf('" ') + 2), /^[A-Za-z0-9_\- ]+$/,
      `helper ${index} must carry only base64url and literal words after the stub`);
  }
});
