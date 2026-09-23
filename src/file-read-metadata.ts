import { createHash } from 'node:crypto';

export type NewlineMode = 'NONE' | 'LF' | 'CRLF' | 'MIXED';

export interface ReadTextMetadata {
  content: string;
  raw_sha256: string;
  size_bytes: number;
  encoding: 'utf-8';
  bom: boolean;
  newline_mode: NewlineMode;
}

/**
 * Preserve exact UTF-8 byte identity before presenting the historical normalized text view.
 *
 * DevSpace's read primitive returns UTF-8 text. Re-encoding that unmodified string therefore
 * preserves CRLF and a leading UTF-8 BOM when present; the acceptance suite pins those cases.
 * Binary/NUL-containing content remains outside file.read's text contract.
 */
export function describeReadableUtf8Text(raw: string): ReadTextMetadata {
  if (raw.includes('\0')) throw new Error('Gateway rejected binary content');
  const bytes = Buffer.from(raw, 'utf8');
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return {
    content: normalized,
    raw_sha256: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
    encoding: 'utf-8',
    bom: raw.charCodeAt(0) === 0xfeff,
    newline_mode: newlineMode(raw),
  };
}

function newlineMode(value: string): NewlineMode {
  const withoutCrlf = value.replace(/\r\n/g, '');
  const hasCrlf = value.includes('\r\n');
  const hasLf = withoutCrlf.includes('\n');
  if (hasCrlf && hasLf) return 'MIXED';
  if (hasCrlf) return 'CRLF';
  if (hasLf) return 'LF';
  return 'NONE';
}
