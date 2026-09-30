import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export const MAX_DOCUMENT_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_DOCUMENT_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_ENTRIES = 512;
const MAX_COMPRESSION_RATIO = 200;

export interface ZipEntryMeta {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
}

export interface SafeZip {
  entries: Record<string, Uint8Array>;
  metadata: ZipEntryMeta[];
  totalUncompressedBytes: number;
}

function readU16(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) {
    throw new Error('Gateway rejected malformed ZIP container');
  }
  return buffer.readUInt16LE(offset);
}

function readU32(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new Error('Gateway rejected malformed ZIP container');
  }
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < 22) throw new Error('Gateway rejected malformed ZIP container');
  const minimum = Math.max(0, buffer.length - (65_535 + 22));
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Gateway rejected malformed ZIP central directory');
}

function validateEntryName(name: string): void {
  if (!name || name.length > 512 || name.includes(String.fromCharCode(0)) || name.includes('\\')) {
    throw new Error('Gateway rejected unsafe ZIP entry name');
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error('Gateway rejected absolute ZIP entry path');
  }
  if (name.split('/').some((segment) => segment === '..')) {
    throw new Error('Gateway rejected ZIP traversal entry');
  }
}

export function inspectZipBounds(
  bytes: Uint8Array,
  label = 'document',
): { metadata: ZipEntryMeta[]; totalUncompressedBytes: number } {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 22 || buffer.length > MAX_DOCUMENT_ARCHIVE_BYTES) {
    throw new Error('Gateway rejected ' + label + ' archive size');
  }

  const eocd = findEndOfCentralDirectory(buffer);
  const disk = readU16(buffer, eocd + 4);
  const centralDisk = readU16(buffer, eocd + 6);
  const entriesOnDisk = readU16(buffer, eocd + 8);
  const entryCount = readU16(buffer, eocd + 10);
  const centralSize = readU32(buffer, eocd + 12);
  const centralOffset = readU32(buffer, eocd + 16);

  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Gateway rejected multi-disk ZIP container');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('Gateway rejected ZIP64 document container');
  }
  if (entryCount < 1 || entryCount > MAX_DOCUMENT_ENTRIES) {
    throw new Error('Gateway rejected ' + label + ' ZIP entry count');
  }
  if (centralOffset + centralSize > eocd) {
    throw new Error('Gateway rejected malformed ZIP central directory bounds');
  }

  const metadata: ZipEntryMeta[] = [];
  const seen = new Set<string>();
  let offset = centralOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(buffer, offset) !== 0x02014b50) {
      throw new Error('Gateway rejected malformed ZIP central directory entry');
    }

    const flags = readU16(buffer, offset + 8);
    const method = readU16(buffer, offset + 10);
    const compressedSize = readU32(buffer, offset + 20);
    const uncompressedSize = readU32(buffer, offset + 24);
    const nameLength = readU16(buffer, offset + 28);
    const extraLength = readU16(buffer, offset + 30);
    const commentLength = readU16(buffer, offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;

    if (end > centralOffset + centralSize || end > buffer.length) {
      throw new Error('Gateway rejected truncated ZIP central directory');
    }
    if ((flags & 0x1) !== 0) throw new Error('Gateway rejected encrypted document archive');
    if (method !== 0 && method !== 8) {
      throw new Error('Gateway rejected unsupported ZIP compression method');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('Gateway rejected ZIP64 document entry');
    }
    if (uncompressedSize > MAX_DOCUMENT_ENTRY_BYTES) {
      throw new Error('Gateway rejected oversized document archive entry');
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      throw new Error('Gateway rejected suspicious document compression ratio');
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
      throw new Error('Gateway rejected suspicious document compression ratio');
    }

    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    validateEntryName(name);
    if (seen.has(name)) throw new Error('Gateway rejected duplicate ZIP entry');
    seen.add(name);

    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_DOCUMENT_UNCOMPRESSED_BYTES) {
      throw new Error('Gateway rejected document archive expansion limit');
    }

    metadata.push({ name, compressedSize, uncompressedSize, method });
    offset = end;
  }

  if (offset !== centralOffset + centralSize) {
    throw new Error('Gateway rejected malformed ZIP central directory length');
  }

  return { metadata, totalUncompressedBytes };
}

export function openSafeZip(bytes: Uint8Array, label = 'document'): SafeZip {
  const inspected = inspectZipBounds(bytes, label);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('Gateway rejected malformed ' + label + ' archive');
  }

  const metadataByName = new Map(inspected.metadata.map((entry) => [entry.name, entry]));
  for (const [name, value] of Object.entries(entries)) {
    const meta = metadataByName.get(name);
    if (!meta || value.byteLength !== meta.uncompressedSize) {
      throw new Error('Gateway rejected document archive identity mismatch');
    }
  }
  if (Object.keys(entries).length !== inspected.metadata.length) {
    throw new Error('Gateway rejected document archive entry mismatch');
  }

  return {
    entries,
    metadata: inspected.metadata,
    totalUncompressedBytes: inspected.totalUncompressedBytes,
  };
}

export function repackSafeZip(entries: Record<string, Uint8Array>): Uint8Array {
  const bytes = zipSync(entries, { level: 6 });
  inspectZipBounds(bytes, 'generated document');
  return bytes;
}

export function zipText(value: string): Uint8Array {
  return strToU8(value);
}

export function unzipText(value: Uint8Array, label: string): string {
  if (value.byteLength > MAX_DOCUMENT_ENTRY_BYTES) {
    throw new Error('Gateway rejected oversized ' + label + ' XML');
  }
  try {
    return strFromU8(value);
  } catch {
    throw new Error('Gateway rejected invalid UTF-8 ' + label + ' XML');
  }
}

function hasInvalidXmlControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

export function assertXmlText(value: string, label: string, maxBytes: number): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error('Gateway rejected oversized ' + label);
  }
  if (hasInvalidXmlControl(value)) {
    throw new Error('Gateway rejected invalid XML control character');
  }
}

export function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function decodeCodePoint(raw: string, radix: number): string {
  const value = Number.parseInt(raw, radix);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x10ffff) {
    throw new Error('Gateway rejected invalid XML character reference');
  }
  return String.fromCodePoint(value);
}

export function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => decodeCodePoint(hex, 16))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => decodeCodePoint(decimal, 10))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\]/g, '\\');
}

export function xmlAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp('(?:^|\\s)' + escapeRegex(name) + '="([^"]*)"'));
  return match ? decodeXmlText(match[1] ?? '') : null;
}

export function documentSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
