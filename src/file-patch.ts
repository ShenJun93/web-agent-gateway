import { createHash } from 'node:crypto';
import { DevspaceReadLimitError, type DevspaceExecutor, type DevspacePatchResult } from './executor/devspace.js';
import { assertReadTarget, validateReadPath } from './path-policy.js';
import type { PatchApprovalStore } from './patch-approval.js';

const MAX_FRAGMENT_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface FilePatchBinding {
  workspaceId: string;
  canonicalRoot: string;
  devspaceWorkspaceId: string;
}
export interface FilePatchInput {
  path: string;
  baseSha256: string;
  before: string;
  after: string;
}
export interface FilePatchApplyInput extends FilePatchInput { approvalId: string; }

interface PreparedPatch {
  path: string;
  original: string;
  candidate: string;
  baseSha256: string;
  resultSha256: string;
  fingerprint: string;
  additions: number;
  removals: number;
}
export class FilePatchController {
  private readonly executor: DevspaceExecutor;
  private readonly approvals: PatchApprovalStore;

  constructor(options: { executor: DevspaceExecutor; approvals: PatchApprovalStore }) {
    this.executor = options.executor;
    this.approvals = options.approvals;
  }

  async preview(binding: FilePatchBinding, input: FilePatchInput) {
    const prepared = await this.prepare(binding, input);
    const request = this.approvals.createPending({
      fingerprint: prepared.fingerprint,
      summary: { path: prepared.path, additions: prepared.additions, removals: prepared.removals },
    });
    return {
      status: 'approval_required' as const,
      approvalId: request.approvalId,
      fingerprint: request.fingerprint,
      expiresAt: request.expiresAt,
      path: prepared.path,
      baseSha256: prepared.baseSha256,
      resultSha256: prepared.resultSha256,
      additions: prepared.additions,
      removals: prepared.removals,
    };
  }

  async apply(binding: FilePatchBinding, input: FilePatchApplyInput) {
    let prepared: PreparedPatch;
    try {
      prepared = await this.prepare(binding, input);
    } catch (error) {
      this.approvals.revoke(input.approvalId);
      throw error;
    }
    const approval = this.approvals.get(input.approvalId);
    if (!approval || approval.fingerprint !== prepared.fingerprint) {
      this.approvals.revoke(input.approvalId);
      throw new Error('Gateway denied patch approval');
    }
    if (!approval.approved) throw new Error('Gateway denied patch approval');
    if (!this.approvals.consume(input.approvalId, prepared.fingerprint)) {
      this.approvals.revoke(input.approvalId);
      throw new Error('Gateway denied patch approval');
    }

    const patch = buildUpdatePatch(prepared.path, prepared.original, prepared.candidate);
    const result = await this.executor.applyPatch(binding.devspaceWorkspaceId, patch);
    assertSingleUpdateResult(result, prepared.path);
    const finalText = await this.readExactTarget(binding.devspaceWorkspaceId, prepared.path);
    if (sha256(finalText) !== prepared.resultSha256) throw new Error('Gateway rejected post-write SHA-256 mismatch');
    return {
      status: 'applied' as const,
      path: prepared.path,
      baseSha256: prepared.baseSha256,
      resultSha256: prepared.resultSha256,
      additions: prepared.additions,
      removals: prepared.removals,
    };
  }
  private async prepare(binding: FilePatchBinding, input: FilePatchInput): Promise<PreparedPatch> {
    validateInput(input);
    const path = validateReadPath(input.path);
    await assertReadTarget(binding.canonicalRoot, path);
    const original = await this.readExactTarget(binding.devspaceWorkspaceId, path);
    rejectUnsafeText(original, 'target');
    if (Buffer.byteLength(original, 'utf8') > MAX_FILE_BYTES) throw new Error('Gateway rejected target exceeds 64 KiB');
    const baseSha256 = sha256(original);
    if (baseSha256 !== input.baseSha256) throw new Error('Gateway rejected base SHA-256 mismatch');
    if (countOccurrences(original, input.before) !== 1) throw new Error('Gateway rejected before text must occur exactly once');

    const candidate = original.replace(input.before, input.after);
    rejectUnsafeText(candidate, 'candidate');
    if (Buffer.byteLength(candidate, 'utf8') > MAX_FILE_BYTES) throw new Error('Gateway rejected candidate exceeds 64 KiB');
    const resultSha256 = sha256(candidate);
    const additions = lineCount(input.after);
    const removals = lineCount(input.before);
    const fingerprint = sha256([
      binding.workspaceId,
      path,
      baseSha256,
      sha256(input.before),
      sha256(input.after),
      resultSha256,
    ].join('\0'));
    return { path, original, candidate, baseSha256, resultSha256, fingerprint, additions, removals };
  }

  private async readExactTarget(workspaceId: string, path: string): Promise<string> {
    let output = '';
    let offset: number | undefined;
    for (let page = 0; page < 64; page += 1) {
      let raw: string;
      try {
        raw = await this.executor.readFile(workspaceId, path, offset, 2000);
      } catch (error) {
        if (error instanceof DevspaceReadLimitError) throw new Error('Gateway rejected target exceeds executor read limit');
        throw error;
      }
      const continuation = splitReadContinuation(raw);
      output += continuation?.content ?? raw;
      if (Buffer.byteLength(output, 'utf8') > MAX_FILE_BYTES) throw new Error('Gateway rejected target exceeds 64 KiB');
      if (!continuation) return output;
      if (offset !== undefined && continuation.nextOffset <= offset) throw new Error('Gateway rejected invalid executor read continuation');
      offset = continuation.nextOffset;
    }
    throw new Error('Gateway rejected excessive executor read pagination');
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
function splitReadContinuation(value: string): { content: string; nextOffset: number } | undefined {
  const match = /\n\[Showing lines \d+-\d+ of \d+ \([^\]]+ limit\)\. Use offset=(\d+) to continue\.\]$/.exec(value);
  if (!match) return undefined;
  const nextOffset = Number(match[1]);
  if (!Number.isSafeInteger(nextOffset) || nextOffset < 1) throw new Error('Gateway rejected invalid executor read continuation');
  return { content: value.slice(0, match.index), nextOffset };
}
function validateInput(input: FilePatchInput): void {
  if (!SHA256_RE.test(input.baseSha256)) throw new Error('Gateway rejected invalid base SHA-256');
  if (!input.before) throw new Error('Gateway rejected before text must be non-empty');
  rejectUnsafeText(input.before, 'before');
  rejectUnsafeText(input.after, 'after');
  if (Buffer.byteLength(input.before, 'utf8') > MAX_FRAGMENT_BYTES) throw new Error('Gateway rejected before exceeds 32 KiB');
  if (Buffer.byteLength(input.after, 'utf8') > MAX_FRAGMENT_BYTES) throw new Error('Gateway rejected after exceeds 32 KiB');
}
function rejectUnsafeText(value: string, label: string): void {
  if (value.includes('\0')) throw new Error(`Gateway rejected ${label} binary content`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function lineCount(value: string): number {
  if (!value) return 0;
  return value.split(/\r?\n/).length - (value.endsWith('\n') ? 1 : 0);
}

export function assertSingleUpdateResult(result: DevspacePatchResult, path: string): void {
  if (result.files.length !== 1 || result.files[0]?.operation !== 'update' || result.files[0]?.path !== path) {
    throw new Error('Gateway rejected DevSpace patch result');
  }
}
