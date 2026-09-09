import { realpath } from 'node:fs/promises';
import { isAbsolute, parse, relative, resolve } from 'node:path';

const SENSITIVE_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube']);

export async function canonicalWorkspace(input: string, allowedRoots: readonly string[]): Promise<string> {
  const requested = input.trim();
  if (!requested) throw new Error('Gateway denied empty workspace path');
  if (isUnsafeWindowsNamespace(requested)) throw new Error('Gateway denied unsafe workspace path');
  if (!isAbsolute(requested)) throw new Error('Gateway denied non-absolute workspace path');
  if (isDriveRoot(requested)) throw new Error('Gateway denied drive-root workspace');
  if (hasSensitiveSegment(requested)) throw new Error('Gateway denied sensitive workspace path');
  if (isSystemWorkspace(requested)) throw new Error('Gateway denied system workspace path');

  const canonical = await realpath(requested);
  if (isDriveRoot(canonical)) throw new Error('Gateway denied drive-root workspace');
  if (hasSensitiveSegment(canonical)) throw new Error('Gateway denied sensitive workspace path');
  if (isSystemWorkspace(canonical)) throw new Error('Gateway denied system workspace path');
  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  if (!roots.some((root) => containsPath(root, canonical))) throw new Error('Gateway denied workspace outside allowed roots');
  return canonical;
}

export async function assertReadTarget(root: string, relativePath: string): Promise<void> {
  const target = await realpath(resolve(root, relativePath));
  if (!containsPath(root, target)) throw new Error('Gateway denied workspace escape');
  if (hasSensitiveSegment(target)) throw new Error('Gateway denied sensitive path');
}

function containsPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isDriveRoot(value: string): boolean {
  const normalized = resolve(value);
  return samePath(normalized, parse(normalized).root);
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isUnsafeWindowsNamespace(value: string): boolean {
  if (process.platform !== 'win32') return false;
  const normalized = value.replaceAll('/', '\\');
  return normalized.startsWith('\\\\');
}

function hasSensitiveSegment(value: string): boolean {
  return value.replaceAll('\\', '/').split('/').some((segment) => SENSITIVE_SEGMENTS.has(segment.toLowerCase()));
}

function isSystemWorkspace(value: string): boolean {
  if (process.platform !== 'win32') return false;
  const candidate = resolve(value);
  const configured = [process.env.SystemRoot ?? 'C:\\Windows', process.env.ProgramData, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter((root): root is string => Boolean(root));
  return configured.some((root) => containsPath(resolve(root), candidate));
}
