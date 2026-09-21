import type { FileMutationBackend } from '../file-mutation-backend.js';
import {
  DevspaceReadLimitError,
  type DevspaceExecutor,
  type DevspacePatchResult,
} from './devspace.js';
import { readDevspaceText } from './devspace-read.js';

const MAX_FILE_BYTES = 64 * 1024;

export class DevspaceFileMutationBackend implements FileMutationBackend {
  readonly kind = 'devspace';

  constructor(private readonly executor: DevspaceExecutor) {}

  async readExact(root: string, path: string): Promise<string> {
    const workspaceId = await this.executor.openWorkspace(root);
    return this.readWorkspaceExact(workspaceId, path);
  }

  /**
   * The executor's read tool reports a missing file as an error string rather than a typed
   * condition, so absence is recognised from that message. Any other failure propagates, because
   * mistaking a permission error for absence would let a creation silently overwrite.
   * `devspace-read-pagination.test.ts` pins this against the pinned executor revision.
   */
  async readExactIfPresent(root: string, path: string): Promise<string | undefined> {
    const workspaceId = await this.executor.openWorkspace(root);
    try {
      return await this.readWorkspaceExact(workspaceId, path);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
  }

  async createNew(root: string, path: string, candidate: string): Promise<void> {
    if (candidate === '') throw new Error('Gateway rejected empty file creation');
    const workspaceId = await this.executor.openWorkspace(root);
    if (await this.readExactIfPresent(root, path) !== undefined) {
      throw new Error('Gateway rejected creation over an existing target');
    }

    const result = await this.executor.applyPatch(workspaceId, buildAddPatch(path, candidate));
    // The executor's add silently overwrites an existing path and reports "update" when it does,
    // so the reported operation is the proof that this created rather than replaced.
    assertSingleResult(result, path, 'add');

    const finalText = await this.readWorkspaceExact(workspaceId, path);
    if (finalText !== candidate) throw new Error('Gateway rejected backend post-write mismatch');
  }

  async updateExisting(root: string, path: string, original: string, candidate: string): Promise<void> {
    const workspaceId = await this.executor.openWorkspace(root);
    const current = await this.readWorkspaceExact(workspaceId, path);
    if (current !== original) throw new Error('Gateway rejected backend stale target');

    const patch = buildUpdatePatch(path, original, candidate);
    const result = await this.executor.applyPatch(workspaceId, patch);
    assertSingleResult(result, path, 'update');

    const finalText = await this.readWorkspaceExact(workspaceId, path);
    if (finalText !== candidate) throw new Error('Gateway rejected backend post-write mismatch');
  }

  private async readWorkspaceExact(workspaceId: string, path: string): Promise<string> {
    try {
      return await readDevspaceText(this.executor, workspaceId, path, {
        maxBytes: MAX_FILE_BYTES,
        oversizedMessage: 'Gateway rejected backend target exceeds 64 KiB',
      });
    } catch (error) {
      if (error instanceof DevspaceReadLimitError) {
        throw new Error('Gateway rejected backend target exceeds executor read limit');
      }
      throw error;
    }
  }
}

function buildUpdatePatch(path: string, original: string, candidate: string): string {
  if (/[\r\n]/.test(path)) throw new Error('Gateway denied workspace-relative path');
  const oldLines = patchLines(original).map((line) => `-${line}`);
  const newLines = patchLines(candidate).map((line) => `+${line}`);
  return [
    '*** Begin Patch',
    `*** Update File: ${path}`,
    '@@',
    ...oldLines,
    ...newLines,
    '*** End Patch',
  ].join('\n');
}

function patchLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  if (value.endsWith('\n')) lines.pop();
  return lines;
}

function assertSingleResult(result: DevspacePatchResult, path: string, operation: 'add' | 'update'): void {
  const file = result.files[0];
  if (result.files.length !== 1 || file?.operation !== operation || file.path !== path || file.previousPath !== undefined) {
    throw new Error('Gateway rejected DevSpace patch result');
  }
}

function buildAddPatch(path: string, candidate: string): string {
  if (/[\r\n]/.test(path)) throw new Error('Gateway denied workspace-relative path');
  return [
    '*** Begin Patch',
    `*** Add File: ${path}`,
    ...patchLines(candidate).map((line) => `+${line}`),
    '*** End Patch',
  ].join('\n');
}

/**
 * The executor has no typed "not found", so absence is matched on the underlying filesystem
 * error it surfaces. Deliberately narrow: EACCES, EPERM and EISDIR must not look like absence.
 */
function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b|no such file or directory/i.test(message);
}
