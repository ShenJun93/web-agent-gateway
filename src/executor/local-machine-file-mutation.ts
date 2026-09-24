import { open, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FileMutationBackend } from '../file-mutation-backend.js';
import { assertCreateTarget, assertReadTarget, validateReadPath } from '../path-policy.js';
import { containsRedactableSecrets, REDACTED_SENTINEL } from '../secret-redaction.js';

const MAX_FILE_BYTES = 64 * 1024;

export class LocalMachineFileMutationBackend implements FileMutationBackend {
  readonly kind = 'local-machine';

  async readExact(root: string, path: string): Promise<string> {
    const safe = validateReadPath(path);
    await assertReadTarget(root, safe);
    const target = await realpath(resolve(root, safe));
    const bytes = await readFile(target);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Gateway rejected local-machine target exceeds 64 KiB');
    return decodeUtf8(bytes);
  }

  async readExactIfPresent(root: string, path: string): Promise<string | undefined> {
    const safe = validateReadPath(path);
    try {
      await assertReadTarget(root, safe);
    } catch (error) {
      if (error instanceof Error && error.message === 'Gateway denied missing path') return undefined;
      throw error;
    }
    return this.readExact(root, safe);
  }

  async createNew(root: string, path: string, candidate: string): Promise<void> {
    if (candidate === '') throw new Error('Gateway rejected empty file creation');
    const safe = validateReadPath(path);
    await assertCreateTarget(root, safe);
    await writeFile(resolve(root, safe), candidate, { encoding: 'utf8', flag: 'wx' });
    if (await this.readExact(root, safe) !== candidate) {
      throw new Error('Gateway rejected local-machine post-write mismatch');
    }
  }

  async updateExisting(root: string, path: string, original: string, candidate: string): Promise<void> {
    const safe = validateReadPath(path);
    await assertReadTarget(root, safe);
    const target = await realpath(resolve(root, safe));
    const handle = await open(target, 'r+');
    try {
      const currentBytes = await handle.readFile();
      if (currentBytes.length > MAX_FILE_BYTES) {
        throw new Error('Gateway rejected local-machine target exceeds 64 KiB');
      }
      const current = decodeUtf8(currentBytes);
      if (current !== original) throw new Error('Gateway rejected local-machine stale target');
      if (containsRedactableSecrets(current) && candidate.includes(REDACTED_SENTINEL)) {
        throw new Error(
          'Gateway denied redacted file.replace round-trip; use mutation.preview exact before/after patch',
        );
      }
      await handle.truncate(0);
      await handle.write(candidate, 0, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await this.readExact(root, safe) !== candidate) {
      throw new Error('Gateway rejected local-machine post-write mismatch');
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Gateway rejected local-machine non-UTF-8 content');
  }
}
