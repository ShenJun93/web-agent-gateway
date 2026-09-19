import test from 'node:test';
import assert from 'node:assert/strict';

test('runtime secrets stay unavailable to repository tests', () => {
  assert.equal(process.env.WAG_TEST_SECRET, undefined);
  assert.equal(process.env.DEVSPACE_OAUTH_OWNER_TOKEN, undefined);
});

test('intentional baseline failure', () => {
  assert.equal('expected', 'actual');
});
