import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePrePublicReadiness,
  parseCandidateEvidenceArgs,
  type ReadinessFacts,
} from '../scripts/check-pre-public-readiness.js';

function readyFacts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    worktreeClean: true,
    browserInspectBasePresent: true,
    candidateEvidencePresent: true,
    candidateEvidenceValid: true,
    candidateContinuity: true,
    requiredFilesPresent: true,
    license: 'Apache-2.0',
    version: '0.1.0',
    readmeHasInspectV2: true,
    readmeHasFiveTools: true,
    readmeLinksPolicies: true,
    signingPolicyPendingAcceptance: true,
    ...overrides,
  };
}

test('publication readiness can pass while release readiness remains blocked on placeholder version', () => {
  const report = evaluatePrePublicReadiness(readyFacts({ version: '0.0.0' }));
  assert.equal(report.publicationReady, true);
  assert.equal(report.releaseReady, false);
  assert.deepEqual(report.blockers, ['release-product-version-placeholder-or-invalid']);
});

test('publication readiness can pass while release readiness remains blocked on stale candidate', () => {
  const report = evaluatePrePublicReadiness(readyFacts({ candidateContinuity: false }));
  assert.equal(report.publicationReady, true);
  assert.equal(report.releaseReady, false);
  assert.deepEqual(report.blockers, ['native-host-candidate-continuity-failed']);
});

test('release readiness passes only when all publication, candidate, and version facts pass', () => {
  const report = evaluatePrePublicReadiness(readyFacts());
  assert.equal(report.publicationReady, true);
  assert.equal(report.releaseReady, true);
  assert.deepEqual(report.blockers, []);
});

test('publication readiness fails closed on trust and public-doc drift', () => {
  const report = evaluatePrePublicReadiness(readyFacts({
    worktreeClean: false,
    candidateContinuity: false,
    license: 'MIT',
    readmeHasFiveTools: false,
    signingPolicyPendingAcceptance: false,
  }));
  assert.equal(report.publicationReady, false);
  assert.equal(report.releaseReady, false);
  assert.deepEqual(report.blockers, [
    'worktree-not-clean',
    'project-license-not-apache-2.0',
    'readme-browser-tool-surface-mismatch',
    'signing-policy-pending-status-missing',
    'native-host-candidate-continuity-failed',
  ]);
});

test('publication readiness does not require candidate evidence but release readiness does', () => {
  const missing = evaluatePrePublicReadiness(readyFacts({
    candidateEvidencePresent: false,
    candidateEvidenceValid: false,
    candidateContinuity: false,
  }));
  assert.equal(missing.publicationReady, true);
  assert.equal(missing.releaseReady, false);
  assert.deepEqual(missing.blockers, ['native-host-candidate-evidence-missing']);

  const invalid = evaluatePrePublicReadiness(readyFacts({
    candidateEvidencePresent: true,
    candidateEvidenceValid: false,
    candidateContinuity: false,
  }));
  assert.equal(invalid.publicationReady, true);
  assert.equal(invalid.releaseReady, false);
  assert.deepEqual(invalid.blockers, ['native-host-candidate-evidence-invalid']);
});

test('candidate evidence CLI requires both absolute paths exactly once', () => {
  assert.equal(parseCandidateEvidenceArgs([]), undefined);
  assert.deepEqual(
    parseCandidateEvidenceArgs([
      '--candidate-receipt', 'C:\\tmp\\candidate.json',
      '--candidate-exe', 'C:\\tmp\\wag-native-host.exe',
    ]),
    {
      receiptPath: 'C:\\tmp\\candidate.json',
      executablePath: 'C:\\tmp\\wag-native-host.exe',
    },
  );
  assert.throws(() => parseCandidateEvidenceArgs(['--candidate-receipt', 'C:\\tmp\\candidate.json']));
  assert.throws(() => parseCandidateEvidenceArgs([
    '--candidate-receipt', 'relative.json',
    '--candidate-exe', 'C:\\tmp\\wag-native-host.exe',
  ]));
  assert.throws(() => parseCandidateEvidenceArgs([
    '--candidate-receipt', 'C:\\tmp\\candidate.json',
    '--candidate-exe', 'C:\\tmp\\other.exe',
  ]));
});
