import type { FileMutationBackend } from '../file-mutation-backend.js';
import {
  DevspaceReadLimitError,
  type DevspaceExecutor,
  type DevspacePatchResult,
} from './devspace.js';

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
    let output = '';
    let offset: number | undefined;
    for (let page = 0; page < 64; page += 1) {
      let raw: string;
      try {
        raw = await this.executor.readFile(workspaceId, path, offset, 2000);
      } catch (error) {
        if (error instanceof DevspaceReadLimitError) {
          throw new Error('Gateway rejected backend target exceeds executor read limit');
        }
        throw error;
      }
      const continuation = splitReadContinuation(raw);
      output += continuation?.content ?? raw;
      if (Buffer.byteLength(output, 'utf8') > MAX_FILE_BYTES) {
        throw new Error('Gateway rejected backend target exceeds 64 KiB');
      }
      if (!continuation) return output;
      if (offset !== undefined && continuation.nextOffset <= offset) {
        throw new Error('Gateway rejected invalid backend read continuation');
      }
      offset = continuation.nextOffset;
    }
    throw new Error('Gateway rejected excessive backend read pagination');
  }
}

function splitReadContinuation(value: string): { content: string; nextOffset: number } | undefined {
  const match = /\n\[Showing lines \d+-\d+ of \d+ \([^\]]+ limit\)\. Use offset=(\d+) to continue\.\]$/.exec(value);
  if (!match) return undefined;
  const nextOffset = Number(match[1]);
  if (!Number.isSafeInteger(nextOffset) || nextOffset < 1) throw new Error('Gateway rejected invalid backend read continuation');
  return { content: value.slice(0, match.index), nextOffset };
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
