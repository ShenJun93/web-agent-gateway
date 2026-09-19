import { DevspaceExecutor } from './executor/devspace.js';
import { assertReadTarget, validateReadPath } from './path-policy.js';

export interface RepoSearchOptions { ignoreCase?: boolean; maxResults?: number; contextLines?: number; }
export interface RepoSearchMatch { path: string; line: number; text: string; before: string[]; after: string[]; }
export interface RepoSearchResult { matches: RepoSearchMatch[]; truncated: boolean; }
export interface RepoSnapshotOptions { maxFiles?: number; }
export interface RepoSnapshotResult { branch: string; head: string; dirty: boolean; status: string[]; diffStat: string; files: string[]; filesTruncated: boolean; }
export interface RepoListOptions { path?: string; maxEntries?: number; }
export interface RepoListEntry { name: string; type: 'file' | 'directory'; tracked: boolean; }
export interface RepoListResult { path: string; entries: RepoListEntry[]; truncated: boolean; }
export interface RepoDiffOptions { path?: string; }
export interface RepoDiffResult { path: string; diff: string; truncated: boolean; }
export interface RepositoryInspectionBackend {
  search(input: { devspaceWorkspaceId: string; canonicalRoot: string; query: string; ignoreCase: boolean; maxResults: number; contextLines: number }): Promise<RepoSearchResult>;
  snapshot(devspaceWorkspaceId: string, options?: RepoSnapshotOptions): Promise<RepoSnapshotResult>;
  list(devspaceWorkspaceId: string, options?: RepoListOptions): Promise<RepoListResult>;
  diff(devspaceWorkspaceId: string, options?: RepoDiffOptions): Promise<RepoDiffResult>;
}

/** Result ceiling shared by every bounded inspection response. */
const MAX_RESULT_BYTES = 64 * 1024;
/** Executor drain budget, in tokens; the backend drains at four characters per token. */
const INSPECTION_OUTPUT_TOKENS = 24_000;
/** Marker the executor inserts when its own ring buffer dropped output. */
const EXECUTOR_TRUNCATION_MARKER = '... output truncated';
/** Emitted by every inspection helper so empty output is distinguishable from framing. */
const HELPER_BEGIN_MARKER = '__WAG_BEGIN__';

const SNAPSHOT_COMMAND = [
  'git --no-optional-locks -c core.fsmonitor=false status --short --branch --ignore-submodules=all',
  'echo __WAG_HEAD__',
  'git --no-optional-locks -c core.fsmonitor=false rev-parse HEAD',
  'echo __WAG_DIFF__',
  'git --no-optional-locks -c core.fsmonitor=false diff --no-ext-diff --no-textconv --ignore-submodules=all --stat -- .',
  'echo __WAG_FILES__',
  'git --no-optional-locks -c core.fsmonitor=false ls-files',
].join(' && ');

function parseSnapshot(output: string) {
  const normalized = output.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n');
  const [statusPart, afterHead] = normalized.split('__WAG_HEAD__\n');
  const [headPart, afterDiff] = (afterHead ?? '').split('__WAG_DIFF__\n');
  const [diffPart, filesPart = ''] = (afterDiff ?? '').split('__WAG_FILES__\n');
  if (afterHead === undefined || afterDiff === undefined) throw new Error('repo.snapshot markers missing from executor output');
  const statusLines = statusPart.trimEnd().split('\n').filter(Boolean);
  const branchLine = statusLines[0] ?? '';
  const branch = branchLine.startsWith('## ') ? branchLine.slice(3).split('...')[0].trim() : '';
  const files = filesPart.split('\n').map((line) => line.trim()).filter(Boolean).sort();
  return {
    branch,
    head: headPart.trim(),
    dirty: statusLines.slice(branchLine.startsWith('## ') ? 1 : 0).length > 0,
    status: statusLines,
    diffStat: diffPart.trim(),
    files,
  };
}

/**
 * Helper sources below are WAG-owned compile-time constants. They are base64url-encoded and
 * evaluated by a `node -e` stub inside the workspace because the executor accepts a single
 * shell command string and offers no argv form.
 *
 * Caller input is never evaluated. A caller-supplied path travels as a separate base64url
 * argv element, is decoded to a plain string inside the helper, and is handed to git as one
 * argv element via spawnSync — so it is never parsed by a shell and cannot inject a command.
 * It has already passed `validateReadPath` before it gets here.
 */
const GIT_BASE_ARGS = "['--no-optional-locks','-c','core.fsmonitor=false']";

const LIST_HELPER_SOURCE = `
const { spawnSync } = require('child_process');
const raw = process.argv[2];
const prefix = raw === '-' ? '' : Buffer.from(raw, 'base64url').toString('utf8');
const target = prefix === '' ? '.' : prefix;
function run(extra) {
  const result = spawnSync('git', ${GIT_BASE_ARGS}.concat(extra, ['--', ':(literal)' + target]), { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) process.exit(2);
  return result.stdout.toString('utf8');
}
const tracked = run(['ls-files', '-z']);
const untracked = run(['ls-files', '-z', '--others', '--exclude-standard']);
const records = [];
for (const entry of tracked.split('\\u0000')) if (entry) records.push('T' + entry);
for (const entry of untracked.split('\\u0000')) if (entry) records.push('U' + entry);
process.stdout.write('__WAG_BEGIN__' + records.join('\\u0000'));
`;

const DIFF_HELPER_SOURCE = `
const { spawnSync } = require('child_process');
const raw = process.argv[2];
const prefix = raw === '-' ? '' : Buffer.from(raw, 'base64url').toString('utf8');
const target = prefix === '' ? '.' : prefix;
const args = ${GIT_BASE_ARGS}.concat(
  ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', 'HEAD', '--', ':(literal)' + target]
);
const result = spawnSync('git', args, { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
if (result.status !== 0) process.exit(2);
process.stdout.write('__WAG_BEGIN__');
process.stdout.write(result.stdout);
`;

const SEARCH_HELPER_SOURCE = `
const { spawnSync } = require('child_process');
const query = Buffer.from(process.argv[2], 'base64url').toString('utf8');
const ignoreCase = process.argv[3] === '1';
const context = process.argv[4];
const args = ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'grep', '-F', '-n', '-I', '-C' + context, '-z'];
if (ignoreCase) args.push('-i');
args.push('--', query);
const result = spawnSync('git', args, { encoding: 'buffer', maxBuffer: 256 * 1024 });
if (result.status === 1 && result.stdout.length === 0) {
  process.exit(1);
} else if (result.status === 0) {
  process.stdout.write(result.stdout);
  process.exit(0);
} else {
  process.exit(2);
}
`;

export class DevspaceRepositoryInspectionBackend implements RepositoryInspectionBackend {
  constructor(private executor: DevspaceExecutor) {}

  async search(input: { devspaceWorkspaceId: string; canonicalRoot: string; query: string; ignoreCase: boolean; maxResults: number; contextLines: number }): Promise<RepoSearchResult> {
    const queryBuffer = Buffer.from(input.query, 'utf8');
    if (queryBuffer.length < 1 || queryBuffer.length > 256 || input.query.includes('\0') || input.query.includes('\r') || input.query.includes('\n')) {
      throw new Error('Gateway denied search query');
    }
    const maxResults = Math.min(Math.max(input.maxResults ?? 20, 1), 50);
    const contextLines = Math.min(Math.max(input.contextLines ?? 1, 0), 2);

    const helper64 = Buffer.from(SEARCH_HELPER_SOURCE, 'utf8').toString('base64url');
    const query64 = queryBuffer.toString('base64url');
    const command = [
      'node -e "eval(Buffer.from(process.argv[1],\'base64url\').toString(\'utf8\'))"',
      helper64,
      query64,
      input.ignoreCase ? '1' : '0',
      String(contextLines),
    ].join(' ');

    const result = await this.executor.execCommand(input.devspaceWorkspaceId, command, undefined, 5000);
    if (result.running) {
      if (result.sessionId) await this.executor.interruptCommand(input.devspaceWorkspaceId, result.sessionId);
      throw new Error('Gateway search failed');
    }
    if (result.exitCode === 1) {
      return { matches: [], truncated: false };
    }
    if (result.exitCode !== 0) {
      throw new Error('Gateway search failed');
    }

    const output = result.output;
    const matches: RepoSearchMatch[] = [];
    let truncated = false;

    // git grep with -z outputs:
    // path\0line\0content\n
    // Groups are separated by "--\n" if context lines are enabled
    const groups = output.split('--\n');
    for (const group of groups) {
      if (!group) continue;
      const lines = group.split('\n');
      // A single group can contain multiple match lines and context lines
      const parsedLines: { path: string; line: number; text: string; isMatch: boolean }[] = [];

      for (let i = 0; i < lines.length; i++) {
        const lineContent = lines[i];
        if (!lineContent) continue;

        const firstNul = lineContent.indexOf('\0');
        if (firstNul === -1) continue;
        const secondNul = lineContent.indexOf('\0', firstNul + 1);
        if (secondNul === -1) continue;

        const path = lineContent.slice(0, firstNul);
        const lineStr = lineContent.slice(firstNul + 1, secondNul);
        const text = lineContent.slice(secondNul + 1);

        if (path.includes('\0') || path.includes('\r') || path.includes('\n')) throw new Error('Gateway search failed');
        const lineNum = parseInt(lineStr, 10);
        if (isNaN(lineNum)) throw new Error('Gateway search failed');

        const matchText = input.ignoreCase ? text.toLowerCase() : text;
        const matchQuery = input.ignoreCase ? input.query.toLowerCase() : input.query;
        const isMatch = matchText.includes(matchQuery);

        parsedLines.push({ path, line: lineNum, text, isMatch });
      }

      for (let i = 0; i < parsedLines.length; i++) {
        if (!parsedLines[i].isMatch) continue;

        const matchLine = parsedLines[i];
        let safePath: string;
        try {
          safePath = validateReadPath(matchLine.path);
          await assertReadTarget(input.canonicalRoot, safePath);
        } catch {
          continue; // skip denied path
        }

        const before: string[] = [];
        const after: string[] = [];

        for (let j = i - 1; j >= 0; j--) {
          if (parsedLines[j].path === matchLine.path) {
            before.unshift(parsedLines[j].text);
            if (before.length === contextLines) break;
          }
        }
        for (let j = i + 1; j < parsedLines.length; j++) {
          if (parsedLines[j].path === matchLine.path) {
            after.push(parsedLines[j].text);
            if (after.length === contextLines) break;
          }
        }

        matches.push({
          path: safePath,
          line: matchLine.line,
          text: matchLine.text,
          before,
          after,
        });
      }
    }

    // Sort matches
    matches.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      if (a.line !== b.line) return a.line - b.line;
      return a.text.localeCompare(b.text);
    });

    if (matches.length > maxResults) {
      matches.splice(maxResults);
      truncated = true;
    }

    // Serialize check
    const serialized = JSON.stringify({ matches, truncated });
    if (Buffer.byteLength(serialized, 'utf8') > 65536) {
      truncated = true;
      while (matches.length > 0 && Buffer.byteLength(JSON.stringify({ matches, truncated }), 'utf8') > 65536) {
        matches.pop();
      }
    }

    return { matches, truncated };
  }

  async snapshot(devspaceWorkspaceId: string, options?: RepoSnapshotOptions): Promise<RepoSnapshotResult> {
    const maxFiles = Math.min(Math.max(options?.maxFiles ?? 100, 1), 500);
    const result = await this.executor.execCommand(devspaceWorkspaceId, SNAPSHOT_COMMAND);
    if (result.running) {
      if (result.sessionId) await this.executor.interruptCommand(devspaceWorkspaceId, result.sessionId);
      throw new Error('repo.snapshot command unexpectedly remained running');
    }
    if (result.exitCode !== 0) throw new Error(`repo.snapshot command failed with exit code ${result.exitCode ?? 'unknown'}`);

    const parsed = parseSnapshot(result.output);

    const files = parsed.files.slice(0, maxFiles);
    const snapshotResult = { ...parsed, files, filesTruncated: parsed.files.length > files.length };

    if (Buffer.byteLength(JSON.stringify(snapshotResult), 'utf8') > 65536) {
      throw new Error('repo.snapshot result exceeded 64 KiB size limit');
    }

    return snapshotResult;
  }

  async list(devspaceWorkspaceId: string, options: RepoListOptions = {}): Promise<RepoListResult> {
    const prefix = normalizePrefix(options.path);
    const maxEntries = Math.min(Math.max(options.maxEntries ?? 200, 1), 1_000);
    const output = await this.runHelper(devspaceWorkspaceId, LIST_HELPER_SOURCE, prefix, 'repo.list');

    const children = new Map<string, RepoListEntry>();
    for (const record of output.text.split('\0')) {
      if (record.length < 2) continue;
      const tracked = record[0] === 'T';
      const full = record.slice(1);
      const relative = prefix === '' ? full : (full.startsWith(`${prefix}/`) ? full.slice(prefix.length + 1) : undefined);
      if (relative === undefined || relative === '') continue;
      const separator = relative.indexOf('/');
      const name = separator === -1 ? relative : relative.slice(0, separator);
      const type = separator === -1 ? 'file' as const : 'directory' as const;
      const existing = children.get(name);
      // A directory stays a directory, and is tracked when any descendant is tracked.
      if (existing) { if (tracked) existing.tracked = true; continue; }
      children.set(name, { name, type, tracked });
    }

    const entries = [...children.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    let truncated = output.truncated || entries.length > maxEntries;
    if (entries.length > maxEntries) entries.splice(maxEntries);
    while (entries.length > 0 && Buffer.byteLength(JSON.stringify({ path: prefix, entries, truncated: true }), 'utf8') > MAX_RESULT_BYTES) {
      entries.pop();
      truncated = true;
    }
    return { path: prefix, entries, truncated };
  }

  async diff(devspaceWorkspaceId: string, options: RepoDiffOptions = {}): Promise<RepoDiffResult> {
    const prefix = normalizePrefix(options.path);
    const output = await this.runHelper(devspaceWorkspaceId, DIFF_HELPER_SOURCE, prefix, 'repo.diff');

    const filtered = withoutSensitiveFiles(output.text.replace(/\r\n/g, '\n'));
    let diff = filtered.diff;
    let truncated = output.truncated || filtered.omitted;
    if (Buffer.byteLength(diff, 'utf8') > MAX_RESULT_BYTES) {
      diff = truncateUtf8Lines(diff, MAX_RESULT_BYTES);
      truncated = true;
    }
    return { path: prefix, diff, truncated };
  }

  private async runHelper(
    devspaceWorkspaceId: string,
    source: string,
    prefix: string,
    tool: string,
  ): Promise<{ text: string; truncated: boolean }> {
    const command = [
      'node -e "eval(Buffer.from(process.argv[1],\'base64url\').toString(\'utf8\'))"',
      Buffer.from(source, 'utf8').toString('base64url'),
      prefix === '' ? '-' : Buffer.from(prefix, 'utf8').toString('base64url'),
    ].join(' ');

    const result = await this.executor.execCommand(devspaceWorkspaceId, command, INSPECTION_OUTPUT_TOKENS);
    if (result.running) {
      if (result.sessionId) await this.executor.interruptCommand(devspaceWorkspaceId, result.sessionId);
      throw new Error(`${tool} command unexpectedly remained running`);
    }
    if (result.exitCode !== 0) throw new Error(`${tool} command failed with exit code ${result.exitCode ?? 'unknown'}`);

    // The executor appends its own "Process exited…" status line and only strips it again
    // when it follows a newline, so a command with empty output would otherwise return that
    // line as if it were content. The begin marker guarantees the output is never empty, which
    // both makes empty payloads unambiguous and keeps the executor's own strip effective.
    //
    // indexOf, not lastIndexOf: the helper writes the marker before any content, so the first
    // occurrence is always the real one and a marker planted in a file name or diff body lands
    // after it and is ignored.
    const begin = result.output.indexOf(HELPER_BEGIN_MARKER);
    if (begin === -1) throw new Error(`${tool} output marker missing from executor output`);
    const payload = result.output.slice(begin + HELPER_BEGIN_MARKER.length);

    const dropped = payload.indexOf(EXECUTOR_TRUNCATION_MARKER);
    if (dropped !== -1) return { text: payload.slice(0, dropped), truncated: true };
    return { text: payload, truncated: false };
  }
}

/**
 * Callers address a subtree by workspace-relative path. The path is never interpolated into a
 * shell command: it is base64url-encoded and decoded inside the helper, which passes it to git
 * as a single argv element.
 */
function normalizePrefix(value: string | undefined): string {
  // Only an genuinely absent prefix means "the whole workspace". Normalising first would let
  // "/" or "\\" collapse to the empty string and silently widen the scope to everything,
  // which is the wrong direction for a confinement function to fail in.
  if (value === undefined || value === '' || value === '.') return '';
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') throw new Error('Gateway denied workspace-relative path');
  return validateReadPath(normalized);
}

/**
 * Drops whole per-file sections whose path is sensitive under the shared path policy.
 *
 * `repo.search` already re-validates every match path, and `file.read` and `mutation.preview`
 * validate their target, so a diff that returned `.env` or `.npmrc` bodies verbatim would be the
 * one tool able to hand over exactly what that policy exists to withhold.
 */
function withoutSensitiveFiles(diff: string): { diff: string; omitted: boolean } {
  if (diff === '') return { diff, omitted: false };
  const sections = diff.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  let omitted = false;
  for (const section of sections) {
    if (section === '') continue;
    if (section.startsWith('diff --git ') && !allowedDiffSection(section)) { omitted = true; continue; }
    kept.push(section);
  }
  return { diff: kept.join(''), omitted };
}

function allowedDiffSection(section: string): boolean {
  const header = section.slice(0, section.indexOf('\n') === -1 ? undefined : section.indexOf('\n'));
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  // An unparsable header is withheld rather than guessed at.
  if (!match) return false;
  for (const path of [match[1]!, match[2]!]) {
    try { validateReadPath(path); }
    catch { return false; }
  }
  return true;
}

/** Cuts UTF-8 text to a byte budget on a line boundary so no character is split. */
function truncateUtf8Lines(value: string, maxBytes: number): string {
  const lines = value.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > maxBytes) break;
    kept.push(line);
    bytes += size;
  }
  return kept.join('\n');
}
