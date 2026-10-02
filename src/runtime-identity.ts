import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface RuntimeIdentity {
  pid: number;
  parent_pid: number;
  cli_path: string;
  runtime_root?: string;
  source_head?: string;
  extension_source_head?: string;
  extension_sha256?: string;
  capability?: string;
  deployed: boolean;
}

/**
 * Report the current WAG process/runtime identity without consulting a shell or process manager.
 *
 * A promoted runtime carries RUNTIME.json two levels above dist/cli.js. Source/test execution has
 * no marker and simply reports the current argv entrypoint with deployed=false.
 */
export function detectRuntimeIdentity(
  cliPath = process.argv[1] ?? process.execPath,
  pid = process.pid,
  parentPid = process.ppid,
): RuntimeIdentity {
  const cli = resolve(cliPath);
  const root = dirname(dirname(cli));
  const markerPath = resolve(root, 'RUNTIME.json');

  if (!existsSync(markerPath)) {
    return {
      pid,
      parent_pid: parentPid,
      cli_path: cli,
      deployed: false,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      sourceHead?: unknown;
      extensionSourceHead?: unknown;
      extensionSha256?: unknown;
      capability?: unknown;
    };
    const sourceHead = typeof parsed.sourceHead === 'string' && /^[a-f0-9]{40}$/.test(parsed.sourceHead)
      ? parsed.sourceHead
      : undefined;
    const extensionSourceHead = typeof parsed.extensionSourceHead === 'string'
      && /^[a-f0-9]{40}$/.test(parsed.extensionSourceHead)
      ? parsed.extensionSourceHead
      : undefined;
    const extensionSha256 = typeof parsed.extensionSha256 === 'string'
      && /^[a-f0-9]{64}$/.test(parsed.extensionSha256)
      ? parsed.extensionSha256
      : undefined;
    const capability = typeof parsed.capability === 'string' && parsed.capability.length <= 128
      ? parsed.capability
      : undefined;

    return {
      pid,
      parent_pid: parentPid,
      cli_path: cli,
      runtime_root: root,
      ...(sourceHead === undefined ? {} : { source_head: sourceHead }),
      ...(extensionSourceHead === undefined ? {} : { extension_source_head: extensionSourceHead }),
      ...(extensionSha256 === undefined ? {} : { extension_sha256: extensionSha256 }),
      ...(capability === undefined ? {} : { capability }),
      deployed: true,
    };
  } catch {
    // Runtime identity is diagnostic only; a malformed marker must never stop WAG from starting.
    return {
      pid,
      parent_pid: parentPid,
      cli_path: cli,
      runtime_root: root,
      deployed: true,
    };
  }
}
