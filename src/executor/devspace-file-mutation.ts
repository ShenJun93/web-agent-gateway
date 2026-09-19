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

  async updateExisting(root: string, path: string, original: string, candidate: string): Promise<void> {
    const workspaceId = await this.executor.openWorkspace(root);
    const current = await this.readWorkspaceExact(workspaceId, path);
    if (current !== original) throw new Error('Gateway rejected backend stale target');

    const patch = buildUpdatePatch(path, original, candidate);
    const result = await this.executor.applyPatch(workspaceId, patch);
    assertSingleUpdateResult(result, path);

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

function assertSingleUpdateResult(result: DevspacePatchResult, path: string): void {
  const file = result.files[0];
  if (result.files.length !== 1 || file?.operation !== 'update' || file.path !== path || file.previousPath !== undefined) {
    throw new Error('Gateway rejected DevSpace patch result');
  }
}
