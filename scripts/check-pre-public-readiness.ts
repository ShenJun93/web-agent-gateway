import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoNativeHostBuildInputChanges } from '../src/browser-adapter/native-host-candidate.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const BROWSER_INSPECT_V2_BASE = 'e19d57789b03dae36901c633482a89714eb52e11';
const READINESS_CANDIDATE_SOURCE = 'e296da18400d0f994fb8f086e36936ccd4c6305b';

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
  if (!facts.candidateContinuity) blockers.push('native-host-candidate-continuity-failed');
  if (!facts.requiredFilesPresent) blockers.push('required-public-files-missing');
  if (facts.license !== 'Apache-2.0') blockers.push('project-license-not-apache-2.0');
  if (!facts.readmeHasInspectV2) blockers.push('readme-browser-inspect-v2-missing');
  if (!facts.readmeHasFiveTools) blockers.push('readme-browser-tool-surface-mismatch');
  if (!facts.readmeLinksPolicies) blockers.push('readme-policy-links-missing');
  if (!facts.signingPolicyPendingAcceptance) blockers.push('signing-policy-pending-status-missing');

  const publicationBlockers = [...blockers];
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

async function regularFile(relativePath: string): Promise<boolean> {
  try {
    const info = await lstat(join(repoRoot, relativePath));
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function collectFacts(): Promise<ReadinessFacts> {
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

  let candidateContinuity = true;
  try {
    const changed = git(['diff', '--name-only', `${READINESS_CANDIDATE_SOURCE}..HEAD`])
      .split(/\r?\n/).filter(Boolean);
    assertNoNativeHostBuildInputChanges(changed);
  } catch {
    candidateContinuity = false;
  }

  const requiredFilesPresent = (await Promise.all(REQUIRED_PUBLIC_FILES.map(regularFile))).every(Boolean);
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    license?: unknown; version?: unknown;
  };
  const readme = await readFile(join(repoRoot, 'README.md'), 'utf8');
  const signingPolicy = await readFile(join(repoRoot, 'docs', 'policies', 'code-signing-policy.md'), 'utf8');
  const toolNames = ['health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read'];

  return {
    worktreeClean: status === '',
    browserInspectBasePresent,
    candidateContinuity,
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
  const report = evaluatePrePublicReadiness(await collectFacts());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`pre-public-readiness: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
