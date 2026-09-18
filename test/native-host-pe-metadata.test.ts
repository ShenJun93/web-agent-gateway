import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_HOST_FILE_DESCRIPTION,
  NATIVE_HOST_INTERNAL_NAME,
  NATIVE_HOST_ORIGINAL_FILENAME,
  NATIVE_HOST_PRODUCT_NAME,
  windowsFileVersion,
} from '../scripts/native-host-pe-metadata.js';

test('native host PE metadata uses stable WAG identity', () => {
  assert.equal(NATIVE_HOST_PRODUCT_NAME, 'Web Agent Gateway');
  assert.equal(NATIVE_HOST_FILE_DESCRIPTION, 'Web Agent Gateway Native Host');
  assert.equal(NATIVE_HOST_INTERNAL_NAME, 'wag-native-host');
  assert.equal(NATIVE_HOST_ORIGINAL_FILENAME, 'wag-native-host.exe');
});

test('native host PE metadata maps numeric SemVer to Windows four-part version', () => {
  assert.equal(windowsFileVersion('0.0.0'), '0.0.0.0');
  assert.equal(windowsFileVersion('1.2.3'), '1.2.3.0');
  assert.equal(windowsFileVersion('65535.0.7'), '65535.0.7.0');
  assert.throws(() => windowsFileVersion('1.2.3-beta.1'), /numeric SemVer/);
  assert.throws(() => windowsFileVersion('65536.0.0'), /between 0 and 65535/);
});
