import { DevspaceExecutor } from './executor/devspace.js';
import { assertReadTarget, validateReadPath } from './path-policy.js';

export interface RepoSearchOptions { ignoreCase?: boolean; maxResults?: number; contextLines?: number; }
export interface RepoSearchMatch { path: string; line: number; text: string; before: string[]; after: string[]; }
export interface RepoSearchResult { matches: RepoSearchMatch[]; truncated: boolean; }
export interface RepoSnapshotOptions { maxFiles?: number; }
export interface RepoSnapshotResult { branch: string; head: string; dirty: boolean; status: string[]; diffStat: string; files: string[]; filesTruncated: boolean; }
export interface RepositoryInspectionBackend {
  search(input: { devspaceWorkspaceId: string; canonicalRoot: string; query: string; ignoreCase: boolean; maxResults: number; contextLines: number }): Promise<RepoSearchResult>;
  snapshot(devspaceWorkspaceId: string, options?: RepoSnapshotOptions): Promise<RepoSnapshotResult>;
}

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
    const result = await this.executor.execCommand(devspaceWorkspaceId, SNAPSHOT_COMMAND, undefined, 5000);
    if (result.running) {
      if (result.sessionId) await this.executor.interruptCommand(devspaceWorkspaceId, result.sessionId);
      throw new Error('repo.snapshot command unexpectedly remained running');
    }
    if (result.exitCode !== 0) throw new Error(`repo.snapshot command failed with exit code ${result.exitCode ?? 'unknown'}`);

    let parsed: ReturnType<typeof parseSnapshot>;
    try {
      parsed = parseSnapshot(result.output);
    } catch {
      throw new Error('Gateway search failed');
    }

    const files = parsed.files.slice(0, maxFiles);
    const snapshotResult = { ...parsed, files, filesTruncated: parsed.files.length > files.length };

    if (Buffer.byteLength(JSON.stringify(snapshotResult), 'utf8') > 65536) {
      throw new Error('Gateway search failed');
    }

    return snapshotResult;
  }
}
