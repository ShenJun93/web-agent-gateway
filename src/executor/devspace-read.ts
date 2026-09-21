import type { DevspaceExecutor } from './devspace.js';

/** Lines requested per executor page. Matches the backend read tool's own line cap. */
export const DEVSPACE_READ_PAGE_LINES = 2000;

const MAX_PAGES = 64;

/**
 * The backend read tool signals "there is more" with three different footers, and the one it
 * actually emits depends on which limit stopped it:
 *
 *   "[Showing lines A-B of T. Use offset=N to continue.]"              line truncation
 *   "[Showing lines A-B of T (50.0KB limit). Use offset=N to continue.]"  byte truncation
 *   "[K more lines in file. Use offset=N to continue.]"                 caller limit stopped early
 *
 * Because every gateway read requests exactly one page worth of lines, the third form is the
 * one produced by an ordinary file longer than a page. Recognising only the byte-truncation
 * form silently returned page one with the footer appended as if it were file content.
 */
const READ_CONTINUATION =
  /\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^\]]*\))?\. Use offset=(\d+) to continue\.|\d+ more lines in file\. Use offset=(\d+) to continue\.)\]$/;

export interface DevspaceReadTextOptions {
  maxBytes: number;
  /** Error message raised when the assembled text exceeds `maxBytes`. */
  oversizedMessage: string;
}

/**
 * Reads one workspace file in full by following the backend's continuation footers.
 *
 * Callers still handle `DevspaceReadLimitError` themselves, because a single line larger than
 * the backend's byte limit is not a pagination problem and cannot be resolved by reading on.
 */
export async function readDevspaceText(
  executor: Pick<DevspaceExecutor, 'readFile'>,
  workspaceId: string,
  path: string,
  options: DevspaceReadTextOptions,
): Promise<string> {
  let output = '';
  let offset: number | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const raw = await executor.readFile(workspaceId, path, offset, DEVSPACE_READ_PAGE_LINES);
    const continuation = splitReadContinuation(raw);
    output += continuation?.content ?? raw;
    if (Buffer.byteLength(output, 'utf8') > options.maxBytes) throw new Error(options.oversizedMessage);
    if (!continuation) return output;
    if (offset !== undefined && continuation.nextOffset <= offset) {
      throw new Error('Gateway rejected invalid backend read continuation');
    }
    offset = continuation.nextOffset;
  }
  throw new Error('Gateway rejected excessive backend read pagination');
}

/**
 * Splits a page into its content and the next offset. The match deliberately starts at the
 * first of the footer's two leading newlines, so exactly one line separator is retained and
 * concatenated pages reproduce the file byte-for-byte.
 */
export function splitReadContinuation(value: string): { content: string; nextOffset: number } | undefined {
  const match = READ_CONTINUATION.exec(value);
  if (!match) return undefined;
  const nextOffset = Number(match[1] ?? match[2]);
  if (!Number.isSafeInteger(nextOffset) || nextOffset < 1) {
    throw new Error('Gateway rejected invalid backend read continuation');
  }
  return { content: value.slice(0, match.index), nextOffset };
}
