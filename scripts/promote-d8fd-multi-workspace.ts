import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APPROVAL = '--approve-multi-workspace';
const Repo = 'E:\\Projects\\web-agent-gateway\\.worktrees\\claude-autonomous-wag-harness-v1';
const ExpectedHead = 'd8fd901d3a16cfa587a4211aadece255be99d11a';
const Short = ExpectedHead.slice(0, 12);
const OldRuntime = 'E:\\WAG-Runtime\\f188b46a3967';
const NewRuntime = 'E:\\WAG-Runtime\\' + Short;
const Config = 'E:\\AI-BROWSER\\wag-acceptance\\wag-live.config.json';
const Wrapper = '/home/pacmap/bin/wag-mcp-stdio.sh';
const Launcher = join(process.env.LOCALAPPDATA ?? '', 'WAG-Local', 'Start-WagLocalTunnel.ps1');
const UrlFile = 'E:\\AI-BROWSER\\wag-acceptance\\devspace-state\\wag-mutation.sqlite.operator-url';
const LaneBase = 'E:\\WAG-Acceptance';
const LogDir = join(LaneBase, 'promotion-logs');
const LaneA = join(LaneBase, 'multi-lane-a-' + ExpectedHead.slice(0, 8));
const LaneB = join(LaneBase, 'multi-lane-b-' + ExpectedHead.slice(0, 8));
const BranchA = 'wag/acceptance-lane-a-' + ExpectedHead.slice(0, 8);
const BranchB = 'wag/acceptance-lane-b-' + ExpectedHead.slice(0, 8);
const Adapter = 'private.stdio.v1';

if (!process.argv.includes(APPROVAL)) {
  throw new Error(
    'Refusing: rerun with ' + APPROVAL
    + ' to promote d8fd and issue the bounded multi-workspace Goal Lease.',
  );
}
if (!process.env.LOCALAPPDATA || !existsSync(Launcher)) {
  throw new Error('WAG launcher missing: ' + Launcher);
}

function run(
  file: string,
  args: readonly string[],
  options: { cwd?: string; allowFailure?: boolean } = {},
) {
  const result = spawnSync(file, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      'Command failed (' + String(result.status) + '): ' + file + ' ' + args.join(' ')
      + '\n' + (result.stderr ?? '').trim(),
    );
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function git(args: readonly string[], cwd = Repo): string {
  return run('git.exe', ['-C', cwd, ...args]).stdout.trim();
}

function writeAtomic(path: string, text: string): void {
  const temp = path + '.activating';
  writeFileSync(temp, text, { encoding: 'utf8' });
  renameSync(temp, path);
}

function ensureJunction(path: string, target: string): void {
  if (existsSync(path)) return;
  symlinkSync(target, path, 'junction');
}

function ensureLane(path: string, branch: string): void {
  if (existsSync(path)) {
    const actualHead = git(['rev-parse', 'HEAD'], path);
    const actualBranch = git(['branch', '--show-current'], path);
    const status = git(['status', '--porcelain'], path);
    if (actualHead !== ExpectedHead || actualBranch !== branch || status !== '') {
      throw new Error(
        'Existing lane is not the expected clean acceptance worktree: ' + path
        + ' branch=' + actualBranch
        + ' head=' + actualHead
        + ' dirty=' + String(status !== ''),
      );
    }
    return;
  }

  const branchExists = run(
    'git.exe',
    ['-C', Repo, 'show-ref', '--verify', '--quiet', 'refs/heads/' + branch],
    { allowFailure: true },
  );
  if (branchExists.status === 0) {
    throw new Error('Acceptance branch exists without expected worktree: ' + branch);
  }

  mkdirSync(dirname(path), { recursive: true });
  run('git.exe', ['-C', Repo, 'worktree', 'add', '-b', branch, path, ExpectedHead]);
}

function wrapperCli(root: string): string {
  return root.replaceAll('\\', '/') + '/dist/cli.js';
}

function switchWrapper(expectedOld: string, next: string): void {
  const python = [
    'import sys',
    'p, old, new = sys.argv[1:]',
    'with open(p, "r", encoding="utf-8", newline=None) as f: s = f.read()',
    'if new not in s:',
    '    if old not in s: raise SystemExit("expected WAG CLI path not found")',
    '    s = s.replace(old, new, 1)',
    'with open(p, "w", encoding="utf-8", newline="\\n") as f: f.write(s)',
  ].join('\n');

  run('wsl.exe', ['-e', 'python3', '-c', python, Wrapper, expectedOld, next]);
  run('wsl.exe', ['-e', 'chmod', '700', Wrapper]);
}

function wagTunnelPid(): number | undefined {
  const listener = run(
    'wsl.exe',
    [
      '-e',
      'bash',
      '-lc',
      'ss -ltnp 2>/dev/null | grep -E "127\\.0\\.0\\.1:8080[[:space:]]" || true',
    ],
  ).stdout;

  const pids = [...listener.matchAll(/pid=(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((value, index, all) => all.indexOf(value) === index);

  if (pids.length === 0) return undefined;
  if (pids.length !== 1) {
    throw new Error('Expected <=1 WAG tunnel on :8080; found ' + String(pids.length));
  }

  const pid = pids[0]!;
  const cmdline = run(
    'wsl.exe',
    ['-e', 'bash', '-lc', "tr '\\0' ' ' < /proc/" + String(pid) + '/cmdline 2>/dev/null'],
  ).stdout.trim();

  if (!cmdline.includes('tunnel-client') || !cmdline.includes('web-agent-gateway')) {
    throw new Error(':8080 belongs to an unexpected process: ' + cmdline);
  }
  return pid;
}

async function stopWagTunnel(): Promise<void> {
  const pid = wagTunnelPid();
  if (pid === undefined) return;

  run('wsl.exe', ['-e', 'kill', '-TERM', String(pid)]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const probe = run('wsl.exe', ['-e', 'kill', '-0', String(pid)], { allowFailure: true });
    if (probe.status !== 0) return;
  }
  throw new Error('WAG tunnel PID ' + String(pid) + ' did not exit');
}

function psSingleQuote(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function windowsPidAlive(pid: number): boolean {
  const probe = run(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'if (Get-Process -Id ' + String(pid)
        + ' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }',
    ],
    { allowFailure: true },
  );
  return probe.status === 0;
}

function startWagTunnel(tag: string) {
  mkdirSync(LogDir, { recursive: true });
  const stdout = join(LogDir, 'wag-' + tag + '.stdout.log');
  const stderr = join(LogDir, 'wag-' + tag + '.stderr.log');
  const pidFile = join(LogDir, 'wag-' + tag + '.launcher.pid');
  rmSync(stdout, { force: true });
  rmSync(stderr, { force: true });
  rmSync(pidFile, { force: true });

  const launcherArgs = [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    Launcher,
  ];
  const bootstrap = [
    "$ErrorActionPreference = 'Stop'",
    '$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source',
    '$p = Start-Process -FilePath $pwsh'
      + ' -ArgumentList @(' + launcherArgs.map(psSingleQuote).join(', ') + ')'
      + ' -WindowStyle Hidden'
      + ' -RedirectStandardOutput ' + psSingleQuote(stdout)
      + ' -RedirectStandardError ' + psSingleQuote(stderr)
      + ' -PassThru',
    '[IO.File]::WriteAllText(' + psSingleQuote(pidFile) + ', [string]$p.Id)',
  ].join('\n');

  const launched = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', bootstrap],
    {
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  if (launched.error) throw launched.error;
  if (launched.status !== 0) {
    throw new Error(
      'WAG launcher bootstrap failed with status ' + String(launched.status)
      + '; stdoutLog=' + stdout
      + '; stderrLog=' + stderr,
    );
  }

  const pidText = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '';
  const hostPid = Number(pidText);
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0) {
    throw new Error(
      'WAG launcher did not persist a valid host PID: ' + JSON.stringify(pidText)
      + '; pidFile=' + pidFile
      + '; stdoutLog=' + stdout
      + '; stderrLog=' + stderr,
    );
  }

  return {
    hostPid,
    stdout,
    stderr,
  };
}

async function waitForWag(
  started: ReturnType<typeof startWagTunnel>,
  label = 'WAG runtime',
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (existsSync(UrlFile)) {
      const candidate = readFileSync(UrlFile, 'utf8').trim();
      if (/^http:\/\/127\.0\.0\.1:\d+\/bootstrap\?token=/.test(candidate)) {
        const tunnelPid = wagTunnelPid();
        if (tunnelPid !== undefined) return;
      }
    }

    if (!windowsPidAlive(started.hostPid)) break;
  }

  let tunnelState = 'none';
  try {
    const pid = wagTunnelPid();
    tunnelState = pid === undefined ? 'none' : String(pid);
  } catch (error) {
    tunnelState = 'probe-error:' + (error instanceof Error ? error.message : String(error));
  }

  throw new Error(
    label + ' did not become ready'
    + '; launcherPid=' + String(started.hostPid)
    + '; launcherAlive=' + String(windowsPidAlive(started.hostPid))
    + '; tunnelPid=' + tunnelState
    + '; stdoutLog=' + started.stdout
    + '; stderrLog=' + started.stderr,
  );
}

const head = git(['rev-parse', 'HEAD']);
const branch = git(['branch', '--show-current']);
if (head !== ExpectedHead) {
  throw new Error('HEAD drifted: expected ' + ExpectedHead + ', found ' + head);
}
if (!branch || /^(main|master|release)$/.test(branch)) {
  throw new Error('Unsafe development branch: ' + branch);
}

console.log('=== VERIFY + BUILD D8FD ===');
const cmdExe = process.env.ComSpec ?? 'cmd.exe';
run(cmdExe, ['/d', '/s', '/c', 'npm.cmd run typecheck'], { cwd: Repo });
run(cmdExe, ['/d', '/s', '/c', 'npm.cmd run build'], { cwd: Repo });

console.log('=== CREATE/VERIFY ACCEPTANCE WORKTREES ===');
ensureLane(LaneA, BranchA);
ensureLane(LaneB, BranchB);

const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
const mainRepo = dirname(commonDir);
const mainNodeModules = join(mainRepo, 'node_modules');
if (!existsSync(mainNodeModules)) {
  throw new Error('node_modules missing: ' + mainNodeModules);
}
ensureJunction(join(LaneA, 'node_modules'), mainNodeModules);
ensureJunction(join(LaneB, 'node_modules'), mainNodeModules);

console.log('=== PREPARE D8FD RUNTIME ===');
mkdirSync(NewRuntime, { recursive: true });
rmSync(join(NewRuntime, 'dist'), { recursive: true, force: true });
cpSync(join(Repo, 'dist'), join(NewRuntime, 'dist'), { recursive: true });
cpSync(join(Repo, 'package.json'), join(NewRuntime, 'package.json'));
ensureJunction(join(NewRuntime, 'node_modules'), mainNodeModules);
writeFileSync(
  join(NewRuntime, 'RUNTIME.json'),
  JSON.stringify(
    {
      sourceHead: ExpectedHead,
      sourceWorktree: Repo,
      promotedAtUtc: new Date().toISOString(),
      capability: 'multi-workspace-development-lanes',
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

const originalConfigText = readFileSync(Config, 'utf8');
let configChanged = false;
let wrapperChanged = false;
let tunnelStopped = false;

try {
  console.log('=== ISSUE MULTI-WORKSPACE SUCCESSOR LEASE ===');

  const moduleAt = async (name: string) =>
    import(pathToFileURL(join(NewRuntime, 'dist', name)).href);
  const { adapterCorrelationDigest } = await moduleAt('adapter-admission.js');
  const { SqliteDurableStore } = await moduleAt('durable-store.js');
  const { validateBindings } = await moduleAt('goal-lease.js');
  const { loadPrivateGatewayConfig } = await moduleAt('private-config.js');
  const { PRIVATE_STDIO_ADAPTER_ID } = await moduleAt('repository-engineering-runtime.js');

  const loaded = await loadPrivateGatewayConfig(Config);
  const mutation = loaded.repositoryEngineering?.mutation;
  if (!mutation?.sessionCorrelation) throw new Error('stable sessionCorrelation missing');
  if (PRIVATE_STDIO_ADAPTER_ID !== Adapter) {
    throw new Error('Unexpected private stdio adapter id: ' + String(PRIVATE_STDIO_ADAPTER_ID));
  }

  const repoRoot = realpathSync.native(Repo);
  const laneARoot = realpathSync.native(LaneA);
  const laneBRoot = realpathSync.native(LaneB);
  const store = new SqliteDurableStore(mutation.statePath);

  let lease: { leaseId: string; sessionId: string; expiresAt: number };
  try {
    const session = store.getOrCreateAdapterSession({
      ownerId: mutation.ownerId,
      adapterId: PRIVATE_STDIO_ADAPTER_ID,
      correlationSha256: adapterCorrelationDigest(
        mutation.ownerId,
        PRIVATE_STDIO_ADAPTER_ID,
        mutation.sessionCorrelation,
      ),
      createdAt: Date.now(),
    });

    const bindings = {
      workspaceRoots: [repoRoot, laneARoot, laneBRoot],
      allowedTools: ['mutation.preview', 'git.commit', 'command.run'],
      pathPatterns: [
        'src/**',
        'test/**',
        'scripts/**',
        'docs/benchmarks/**',
        'docs/research/**',
        'README.md',
      ],
      maxFiles: 128,
      maxBytes: 4 * 1024 * 1024,
      maxDiffBytes: 256 * 1024,
      admittedSessions: [session.sessionId],
      admittedAdapters: [PRIVATE_STDIO_ADAPTER_ID],
      commitSemantics: 'commit-to-bound-branch',
      commitBindings: [
        { workspaceRoot: repoRoot, branch, headSha: ExpectedHead },
        { workspaceRoot: laneARoot, branch: BranchA, headSha: ExpectedHead },
        { workspaceRoot: laneBRoot, branch: BranchB, headSha: ExpectedHead },
      ],
    };

    const malformed = validateBindings(bindings);
    if (malformed) {
      throw new Error('Invalid intended multi-workspace lease: ' + malformed);
    }

    const now = Date.now();
    const leaseId =
      'lease_' + now.toString(36) + '_' + Math.random().toString(16).slice(2, 10);
    const expiresAt = now + 4 * 60 * 60 * 1000;

    store.insertGoalLease({
      leaseId,
      createdAt: now,
      notBefore: now - 1_000,
      expiresAt,
      bindings: JSON.stringify(bindings),
    });

    lease = {
      leaseId,
      sessionId: session.sessionId,
      expiresAt,
    };
  } finally {
    store.close();
  }

  const config = JSON.parse(originalConfigText) as {
    repositoryEngineering?: { mutation?: Record<string, unknown> };
  };
  const liveMutation = config.repositoryEngineering?.mutation;
  if (!liveMutation) {
    throw new Error('repositoryEngineering.mutation missing in live config');
  }
  liveMutation.goalLeaseId = lease.leaseId;
  writeAtomic(Config, JSON.stringify(config, null, 2) + '\n');
  configChanged = true;

  const checked = await loadPrivateGatewayConfig(Config);
  if (checked.repositoryEngineering?.mutation?.goalLeaseId !== lease.leaseId) {
    throw new Error('final config did not name the successor Goal Lease');
  }

  console.log('=== SWITCH LF-SAFE WRAPPER ===');
  const oldCli = wrapperCli(OldRuntime);
  const newCli = wrapperCli(NewRuntime);
  switchWrapper(oldCli, newCli);
  wrapperChanged = true;

  console.log('=== RESTART WAG TUNNEL ONLY ===');
  await stopWagTunnel();
  tunnelStopped = true;
  rmSync(UrlFile, { force: true });
  const promotedStart = startWagTunnel('d8fd');
  await waitForWag(promotedStart, 'Promoted WAG runtime');

  rmSync(fileURLToPath(import.meta.url), { force: true });

  console.log('');
  console.log('MULTI_WORKSPACE_PROMOTION_OK=True');
  console.log('RUNTIME=' + NewRuntime);
  console.log('LEASE_ID=' + lease.leaseId);
  console.log('LEASE_SESSION=' + lease.sessionId);
  console.log('LANE_A=' + LaneA);
  console.log('LANE_A_BRANCH=' + BranchA);
  console.log('LANE_B=' + LaneB);
  console.log('LANE_B_BRANCH=' + BranchB);
  console.log('PFP_AUTHORITY=False');
} catch (error) {
  console.warn(
    'PROMOTION FAILED: ' + (error instanceof Error ? error.message : String(error)),
  );

  if (configChanged) {
    try {
      writeAtomic(Config, originalConfigText);
    } catch {
      // Best effort. The original failure remains primary.
    }
  }

  if (wrapperChanged) {
    try {
      switchWrapper(wrapperCli(NewRuntime), wrapperCli(OldRuntime));
    } catch {
      // Best effort.
    }
  }

  if (tunnelStopped) {
    try {
      await stopWagTunnel();
    } catch {
      // Best effort.
    }
    try {
      rmSync(UrlFile, { force: true });
      const rollbackStart = startWagTunnel('rollback-f188');
      await waitForWag(rollbackStart, 'Rollback WAG runtime');
    } catch (rollbackError) {
      console.warn(
        'ROLLBACK FAILED: '
        + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
      );
    }
  }

  throw error;
}
