import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePrePublicReadiness, type ReadinessFacts } from '../scripts/check-pre-public-readiness.js';

function readyFacts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    worktreeClean: true,
    browserInspectBasePresent: true,
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

test('release readiness passes only when all publication and version facts pass', () => {
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
    'native-host-candidate-continuity-failed',
    'project-license-not-apache-2.0',
    'readme-browser-tool-surface-mismatch',
    'signing-policy-pending-status-missing',
  ]);
});
