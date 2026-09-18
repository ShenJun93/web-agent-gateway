import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertNoNativeHostBuildInputChanges,
  parseNativeHostSignatureInspection,
  parseNativeHostUnsignedCandidateReceipt,
  sha256File,
} from '../src/browser-adapter/native-host-candidate.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const BROWSER_INSPECT_V2_BASE = 'e19d57789b03dae36901c633482a89714eb52e11';
const EXPECTED_REPOSITORY = 'ShenJun93/web-agent-gateway';

const REQUIRED_PUBLIC_FILES = [
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/native-host-installation.md',
  'docs/policies/code-signing-policy.md',
  'docs/policies/privacy.md',
  'browser/native-host/third-party-components.json',
  'third_party/native-host/NODE-v24.20.0-LICENSE',
] as const;

export interface ReadinessFacts {
  worktreeClean: boolean;
  browserInspectBasePresent: boolean;
  candidateEvidencePresent: boolean;
  candidateEvidenceValid: boolean;
  candidateContinuity: boolean;
  requiredFilesPresent: boolean;
  license: string | undefined;
  version: string | undefined;
  readmeHasInspectV2: boolean;
  readmeHasFiveTools: boolean;
  readmeLinksPolicies: boolean;
  signingPolicyPendingAcceptance: boolean;
}

export interface ReadinessReport {
  publicationReady: boolean;
  releaseReady: boolean;
  blockers: readonly string[];
  facts: ReadinessFacts;
}

export function evaluatePrePublicReadiness(facts: ReadinessFacts): ReadinessReport {
  const blockers: string[] = [];
  if (!facts.worktreeClean) blockers.push('worktree-not-clean');
  if (!facts.browserInspectBasePresent) blockers.push('browser-inspect-v2-base-missing');
  if (!facts.requiredFilesPresent) blockers.push('required-public-files-missing');
  if (facts.license !== 'Apache-2.0') blockers.push('project-license-not-apache-2.0');
  if (!facts.readmeHasInspectV2) blockers.push('readme-browser-inspect-v2-missing');
  if (!facts.readmeHasFiveTools) blockers.push('readme-browser-tool-surface-mismatch');
  if (!facts.readmeLinksPolicies) blockers.push('readme-policy-links-missing');
  if (!facts.signingPolicyPendingAcceptance) blockers.push('signing-policy-pending-status-missing');

  const publicationBlockers = [...blockers];
  if (!facts.candidateEvidencePresent) blockers.push('native-host-candidate-evidence-missing');
  else if (!facts.candidateEvidenceValid) blockers.push('native-host-candidate-evidence-invalid');
  else if (!facts.candidateContinuity) blockers.push('native-host-candidate-continuity-failed');
  const numericVersion = typeof facts.version === 'string' && /^\d+\.\d+\.\d+$/.test(facts.version);
  const releaseVersionReady = numericVersion && facts.version !== '0.0.0';
  if (!releaseVersionReady) blockers.push('release-product-version-placeholder-or-invalid');

  return {
    publicationReady: publicationBlockers.length === 0,
    releaseReady: blockers.length === 0,
    blockers,
    facts,
  };
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim();
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

export interface CandidateEvidenceInput {
  receiptPath: string;
  executablePath: string;
}

export function parseCandidateEvidenceArgs(args: readonly string[]): CandidateEvidenceInput | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 4) throw new Error('Expected --candidate-receipt and --candidate-exe together');
  const receiptIndex = args.indexOf('--candidate-receipt');
  const executableIndex = args.indexOf('--candidate-exe');
  if (
    receiptIndex < 0
    || executableIndex < 0
    || args.lastIndexOf('--candidate-receipt') !== receiptIndex
    || args.lastIndexOf('--candidate-exe') !== executableIndex
  ) {
    throw new Error('Expected exactly one --candidate-receipt and one --candidate-exe');
  }
  const receiptPath = args[receiptIndex + 1];
  const executablePath = args[executableIndex + 1];
  if (!receiptPath || !executablePath || receiptPath.startsWith('--') || executablePath.startsWith('--')) {
    throw new Error('Candidate evidence options require values');
  }
  if (!isAbsolute(receiptPath) || !isAbsolute(executablePath)) {
    throw new Error('Candidate evidence paths must be absolute');
  }
  if (basename(executablePath).toLowerCase() !== 'wag-native-host.exe') {
    throw new Error('Candidate executable filename must be wag-native-host.exe');
  }
  return { receiptPath, executablePath };
}

async function collectCandidateFacts(input: CandidateEvidenceInput | undefined): Promise<{
  candidateEvidencePresent: boolean;
  candidateEvidenceValid: boolean;
  candidateContinuity: boolean;
}> {
  if (!input) {
    return {
      candidateEvidencePresent: false,
      candidateEvidenceValid: false,
      candidateContinuity: false,
    };
  }

  try {
    if (!(await regularFile(input.receiptPath)) || !(await regularFile(input.executablePath))) {
      throw new Error('Candidate evidence must be regular files');
    }
    const receipt = parseNativeHostUnsignedCandidateReceipt(
      JSON.parse(await readFile(input.receiptPath, 'utf8')) as unknown,
    );
    if (receipt.repository !== EXPECTED_REPOSITORY) throw new Error('Candidate repository mismatch');

    const sourcePackageLock = execFileSync(
      'git',
      ['show', `${receipt.sourceSha}:package-lock.json`],
      { cwd: repoRoot, windowsHide: true },
    );
    if (sha256(sourcePackageLock) !== receipt.packageLockSha256) {
      throw new Error('Candidate source package-lock hash mismatch');
    }
    if ((await sha256File(input.executablePath)) !== receipt.preSignSha256) {
      throw new Error('Candidate executable hash mismatch');
    }

    const signatureScript = fileURLToPath(new URL('./inspect-native-host-signature.ps1', import.meta.url));
    const signatureOutput = execFileSync(
      'powershell.exe',
      [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-File', signatureScript,
        '-ExecutablePath', input.executablePath, '-ExpectedState', 'Unsigned',
      ],
      { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
    ).trim();
    const inspection = parseNativeHostSignatureInspection(JSON.parse(signatureOutput) as unknown);
    if (inspection.status !== 'NotSigned' || inspection.authenticodeSha256 !== receipt.authenticodeSha256) {
      throw new Error('Candidate unsigned signature evidence mismatch');
    }

    let candidateContinuity = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', receipt.sourceSha, 'HEAD'], {
        cwd: repoRoot, stdio: 'ignore', windowsHide: true,
      });
      const changed = git(['diff', '--name-only', `${receipt.sourceSha}..HEAD`, '--'])
        .split(/\r?\n/).filter(Boolean);
      assertNoNativeHostBuildInputChanges(changed);
      candidateContinuity = true;
    } catch {
      candidateContinuity = false;
    }

    if (candidateContinuity) {
      const versionScript = fileURLToPath(new URL('./verify-native-host-version-info.ps1', import.meta.url));
      execFileSync(
        'powershell.exe',
        [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-File', versionScript,
          '-ExecutablePath', input.executablePath,
          '-PackageJsonPath', join(repoRoot, 'package.json'),
        ],
        { cwd: repoRoot, stdio: 'ignore', windowsHide: true },
      );
    }

    return {
      candidateEvidencePresent: true,
      candidateEvidenceValid: true,
      candidateContinuity,
    };
  } catch {
    return {
      candidateEvidencePresent: true,
      candidateEvidenceValid: false,
      candidateContinuity: false,
    };
  }
}

async function collectFacts(candidateInput?: CandidateEvidenceInput): Promise<ReadinessFacts> {
  const status = git(['status', '--porcelain']);
  let browserInspectBasePresent = false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', BROWSER_INSPECT_V2_BASE, 'HEAD'], {
      cwd: repoRoot, stdio: 'ignore', windowsHide: true,
    });
    browserInspectBasePresent = true;
  } catch {
    browserInspectBasePresent = false;
  }

  const candidateFacts = await collectCandidateFacts(candidateInput);
  const requiredFilesPresent = (
    await Promise.all(REQUIRED_PUBLIC_FILES.map((path) => regularFile(join(repoRoot, path))))
  ).every(Boolean);
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    license?: unknown; version?: unknown;
  };
  const readme = await readFile(join(repoRoot, 'README.md'), 'utf8');
  const signingPolicy = await readFile(join(repoRoot, 'docs', 'policies', 'code-signing-policy.md'), 'utf8');
  const toolNames = ['health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read'];

  return {
    worktreeClean: status === '',
    browserInspectBasePresent,
    ...candidateFacts,
    requiredFilesPresent,
    license: typeof packageJson.license === 'string' ? packageJson.license : undefined,
    version: typeof packageJson.version === 'string' ? packageJson.version : undefined,
    readmeHasInspectV2: readme.includes('Browser Inspect v2'),
    readmeHasFiveTools: toolNames.every((tool) => readme.includes(`\`${tool}\``)),
    readmeLinksPolicies:
      readme.includes('docs/policies/code-signing-policy.md')
      && readme.includes('docs/policies/privacy.md')
      && readme.includes('SECURITY.md')
      && readme.includes('CONTRIBUTING.md'),
    signingPolicyPendingAcceptance:
      signingPolicy.includes('does not claim that WAG has already been accepted')
      || signingPolicy.includes('does not claim SignPath acceptance'),
  };
}

async function main(): Promise<void> {
  const candidateInput = parseCandidateEvidenceArgs(process.argv.slice(2));
  const report = evaluatePrePublicReadiness(await collectFacts(candidateInput));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`pre-public-readiness: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
