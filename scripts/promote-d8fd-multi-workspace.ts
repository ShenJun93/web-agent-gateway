import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline/promises';
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
import { pathToFileURL } from 'node:url';
import {
  rolloverCommitBindingHeads,
  type GoalLeaseBindings,
  type LeaseSpend,
  type WorkspaceCommitObservation,
} from '../src/goal-lease.js';

const APPROVAL = '--approve-multi-workspace';
const ROLLOVER_PREVIEW = '--preview-rollover';
const ROLLOVER_APPLY = '--apply-rollover';
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

const promotionRequested = process.argv.includes(APPROVAL);
const rolloverPreviewRequested = process.argv.includes(ROLLOVER_PREVIEW);
const rolloverApplyIndex = process.argv.indexOf(ROLLOVER_APPLY);
const rolloverApplyRequested = rolloverApplyIndex !== -1;
const rolloverApplyDigest = rolloverApplyRequested ? process.argv[rolloverApplyIndex + 1] : undefined;
if (Number(promotionRequested) + Number(rolloverPreviewRequested) + Number(rolloverApplyRequested) !== 1) {
  throw new Error(
    'Refusing: choose exactly one mode: ' + APPROVAL + ', ' + ROLLOVER_PREVIEW
    + ', or ' + ROLLOVER_APPLY + ' <reviewed-plan-sha256>.',
  );
}
if (rolloverApplyRequested && !/^[a-f0-9]{64}$/.test(rolloverApplyDigest ?? '')) {
  throw new Error(ROLLOVER_APPLY + ' requires the exact reviewed 64-hex plan digest');
}
if ((promotionRequested || rolloverApplyRequested)
  && (!process.env.LOCALAPPDATA || !existsSync(Launcher))) {
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

interface RolloverPlan {
  version: 'wag.goal-lease-rollover.v1';
  sourceConfigSha256: string;
  sourceLeaseId: string;
  sourceLeaseExpiresAt: number;
  sourceSpend: LeaseSpend;
  observations: readonly WorkspaceCommitObservation[];
  successorBindings: GoalLeaseBindings;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildRolloverPlan(): { plan: RolloverPlan; digest: string } {
  const configText = readFileSync(Config, 'utf8');
  const config = JSON.parse(configText) as {
    repositoryEngineering?: {
      mutation?: {
        statePath?: unknown;
        goalLeaseId?: unknown;
      };
    };
  };
  const mutation = config.repositoryEngineering?.mutation;
  if (typeof mutation?.statePath !== 'string' || mutation.statePath.length === 0) {
    throw new Error('Live config has no mutation statePath; rollover preview is unavailable');
  }
  if (typeof mutation.goalLeaseId !== 'string' || mutation.goalLeaseId.length === 0) {
    throw new Error('Live config names no Goal Lease; there is nothing to roll over');
  }
  if (!existsSync(mutation.statePath)) {
    throw new Error('Goal Lease state database is missing: ' + mutation.statePath);
  }

  const db = new DatabaseSync(mutation.statePath, { readOnly: true });
  let source: {
    lease_id: string;
    created_at: number;
    not_before: number;
    expires_at: number;
    revoked_at: number | null;
    bindings: string;
  };
  let spend: LeaseSpend;
  try {
    const row = db.prepare(
      'SELECT lease_id, created_at, not_before, expires_at, revoked_at, bindings '
      + 'FROM goal_leases WHERE lease_id = ?',
    ).get(mutation.goalLeaseId) as typeof source | undefined;
    if (!row) throw new Error('Configured Goal Lease row is missing: ' + mutation.goalLeaseId);
    source = row;

    const spent = db.prepare(
      'SELECT COUNT(DISTINCT workspace_id || char(10) || path) AS files, '
      + 'COALESCE(SUM(diff_bytes), 0) AS bytes '
      + 'FROM mutation_authority WHERE lease_id = ?',
    ).get(mutation.goalLeaseId) as { files: number; bytes: number };
    spend = { filesChanged: Number(spent.files), bytesWritten: Number(spent.bytes) };
  } finally {
    db.close();
  }

  const now = Date.now();
  if (source.revoked_at !== null) throw new Error('Configured Goal Lease is already revoked');
  if (now < source.not_before) throw new Error('Configured Goal Lease is not yet valid');
  if (now >= source.expires_at) {
    throw new Error('Configured Goal Lease has expired; rollover cannot renew its time window');
  }

  let bindings: GoalLeaseBindings;
  try {
    bindings = JSON.parse(source.bindings) as GoalLeaseBindings;
  } catch {
    throw new Error('Configured Goal Lease bindings are not valid JSON');
  }
  if (!Array.isArray(bindings.commitBindings) || bindings.commitBindings.length === 0) {
    throw new Error('Rollover v1 requires a multi-workspace Goal Lease with commitBindings');
  }

  const observations = bindings.commitBindings.map((binding): WorkspaceCommitObservation => {
    const root = realpathSync.native(binding.workspaceRoot);
    return {
      workspaceRoot: binding.workspaceRoot,
      branch: git(['branch', '--show-current'], root),
      headSha: git(['rev-parse', 'HEAD'], root),
    };
  });
  const successorBindings = rolloverCommitBindingHeads(bindings, observations, spend);
  const plan: RolloverPlan = {
    version: 'wag.goal-lease-rollover.v1',
    sourceConfigSha256: sha256Text(configText),
    sourceLeaseId: source.lease_id,
    sourceLeaseExpiresAt: source.expires_at,
    sourceSpend: spend,
    observations,
    successorBindings,
  };
  return { plan, digest: sha256Text(JSON.stringify(plan)) };
}

if (rolloverPreviewRequested) {
  const measured = buildRolloverPlan();
  console.log('=== GOAL LEASE ROLLOVER V1 PREVIEW ===');
  console.log(JSON.stringify(measured.plan, null, 2));
  console.log('ROLLOVER_PLAN_SHA256=' + measured.digest);
  console.log('ROLLOVER_PREVIEW_ONLY=True');
  console.log('Human action required: rerun in an interactive terminal with '
    + ROLLOVER_APPLY + ' ' + measured.digest + '.');
  console.log('A successor cannot extend sourceLeaseExpiresAt; a longer window is a new grant.');
  process.exit(0);
}

async function applyRollover(reviewedDigest: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Rollover apply requires an interactive TTY human confirmation; automation and command.run are refused.',
    );
  }

  const measured = buildRolloverPlan();
  if (measured.digest !== reviewedDigest) {
    throw new Error(
      'Reviewed rollover digest no longer matches live state: expected '
      + reviewedDigest + ', current ' + measured.digest,
    );
  }

  console.log('=== GOAL LEASE ROLLOVER V1 APPLY ===');
  console.log(JSON.stringify(measured.plan, null, 2));
  console.log('REVIEWED_ROLLOVER_PLAN_SHA256=' + reviewedDigest);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer = '';
  try {
    answer = await rl.question('Type APPLY ' + reviewedDigest + ' to issue and activate this successor: ');
  } finally {
    rl.close();
  }
  if (answer.trim() !== 'APPLY ' + reviewedDigest) {
    throw new Error('Human confirmation did not match the reviewed rollover digest');
  }

  // The human may spend time reviewing. Re-measure everything after the gesture so the digest is
  // also a CAS over config, durable spend, branches and HEADs at the instant authority is changed.
  const fresh = buildRolloverPlan();
  if (fresh.digest !== reviewedDigest) {
    throw new Error(
      'Rollover state changed while awaiting confirmation: reviewed '
      + reviewedDigest + ', current ' + fresh.digest,
    );
  }

  const originalConfigText = readFileSync(Config, 'utf8');
  if (sha256Text(originalConfigText) !== fresh.plan.sourceConfigSha256) {
    throw new Error('Live config changed after rollover revalidation');
  }
  const config = JSON.parse(originalConfigText) as {
    repositoryEngineering?: {
      mutation?: {
        statePath?: unknown;
        goalLeaseId?: unknown;
      };
    };
  };
  const mutation = config.repositoryEngineering?.mutation;
  if (typeof mutation?.statePath !== 'string'
    || mutation.goalLeaseId !== fresh.plan.sourceLeaseId) {
    throw new Error('Live config no longer names the reviewed source lease');
  }

  const now = Date.now();
  if (now >= fresh.plan.sourceLeaseExpiresAt) {
    throw new Error('Source lease expired before rollover activation');
  }
  const successorId = 'lease_' + now.toString(36) + '_' + randomBytes(4).toString('hex');

  const db = new DatabaseSync(mutation.statePath);
  let successorInserted = false;
  let configChanged = false;
  let tunnelStopped = false;
  try {
    db.prepare(
      'INSERT INTO goal_leases (lease_id, created_at, not_before, expires_at, bindings) '
      + 'VALUES (?, ?, ?, ?, ?)',
    ).run(
      successorId,
      now,
      now - 1_000,
      fresh.plan.sourceLeaseExpiresAt,
      JSON.stringify(fresh.plan.successorBindings),
    );
    successorInserted = true;

    mutation.goalLeaseId = successorId;
    writeAtomic(Config, JSON.stringify(config, null, 2) + '\n');
    configChanged = true;

    const reread = JSON.parse(readFileSync(Config, 'utf8')) as {
      repositoryEngineering?: { mutation?: { goalLeaseId?: unknown } };
    };
    if (reread.repositoryEngineering?.mutation?.goalLeaseId !== successorId) {
      throw new Error('Live config did not persist the successor lease id');
    }

    await stopWagTunnel();
    tunnelStopped = true;
    rmSync(UrlFile, { force: true });
    const started = startWagTunnel('rollover-' + successorId.slice(-8));
    await waitForWag(started, 'Rollover WAG runtime');

    const revoked = db.prepare(
      'UPDATE goal_leases SET revoked_at = ? WHERE lease_id = ? AND revoked_at IS NULL',
    ).run(Date.now(), fresh.plan.sourceLeaseId);
    if (Number(revoked.changes) !== 1) {
      throw new Error('Source lease was not revoked after successor activation');
    }

    console.log('ROLLOVER_APPLY_OK=True');
    console.log('SOURCE_LEASE_ID=' + fresh.plan.sourceLeaseId);
    console.log('SUCCESSOR_LEASE_ID=' + successorId);
    console.log('SUCCESSOR_EXPIRES_AT=' + String(fresh.plan.sourceLeaseExpiresAt));
    console.log('ROLLOVER_PLAN_SHA256=' + reviewedDigest);
  } catch (error) {
    if (configChanged) {
      try { writeAtomic(Config, originalConfigText); } catch {}
    }
    if (successorInserted) {
      try {
        db.prepare(
          'UPDATE goal_leases SET revoked_at = ? WHERE lease_id = ? AND revoked_at IS NULL',
        ).run(Date.now(), successorId);
      } catch {}
    }
    if (tunnelStopped) {
      try {
        await stopWagTunnel();
        rmSync(UrlFile, { force: true });
        const rollback = startWagTunnel('rollback-rollover');
        await waitForWag(rollback, 'Rollback rollover WAG runtime');
      } catch (rollbackError) {
        console.warn(
          'ROLLOVER ROLLBACK FAILED: '
          + (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
        );
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

if (rolloverApplyRequested) {
  await applyRollover(rolloverApplyDigest!);
  process.exit(0);
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
