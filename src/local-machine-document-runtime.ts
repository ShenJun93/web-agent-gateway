import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

import {
  createDocx,
  inspectDocx,
  replaceDocxText,
  type DocxInspectOptions,
} from './document-docx.js';
import {
  createTextPdf,
  overlayPdfText,
  type PdfOverlayOptions,
  type PdfTextOptions,
} from './document-pdf.js';
import {
  createXlsx,
  inspectXlsx,
  setXlsxCells,
  type XlsxCellInput,
  type XlsxInspectOptions,
  type XlsxSheetInput,
} from './document-xlsx.js';
import { documentSha256 } from './document-zip.js';
import { assertCreateTarget, assertReadTarget, validateReadPath } from './path-policy.js';
import { redactSecrets } from './secret-redaction.js';

const MAX_DOCUMENT_FILE_BYTES = 32 * 1024 * 1024;

export interface LocalMachineDocumentContext {
  inspectDocx(workspaceId: string, path: string, options?: DocxInspectOptions): Promise<object>;
  createDocx(workspaceId: string, path: string, paragraphs: readonly string[]): Promise<object>;
  replaceDocxText(
    workspaceId: string,
    path: string,
    expectedSha256: string,
    find: string,
    replacement: string,
    replaceAll?: boolean,
  ): Promise<object>;
  inspectXlsx(workspaceId: string, path: string, options?: XlsxInspectOptions): Promise<object>;
  createXlsx(workspaceId: string, path: string, sheets: readonly XlsxSheetInput[]): Promise<object>;
  setXlsxCells(
    workspaceId: string,
    path: string,
    expectedSha256: string,
    sheet: string,
    cells: readonly XlsxCellInput[],
  ): Promise<object>;
  createPdf(
    workspaceId: string,
    path: string,
    pages: readonly string[],
    options?: PdfTextOptions,
  ): Promise<object>;
  overlayPdfText(
    workspaceId: string,
    path: string,
    expectedSha256: string,
    options: PdfOverlayOptions,
  ): Promise<object>;
}

interface DocumentFile {
  safePath: string;
  target: string;
  bytes: Buffer;
  sha256: string;
}

function assertDocumentExtension(
  path: string,
  extension: '.docx' | '.xlsx' | '.pdf',
): void {
  if (!path.toLowerCase().endsWith(extension)) {
    throw new Error('Gateway rejected document extension; expected ' + extension);
  }
}

function assertExpectedSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Gateway rejected document expected SHA-256');
  }
}

async function readDocumentFile(
  root: string,
  path: string,
  extension: '.docx' | '.xlsx' | '.pdf',
): Promise<DocumentFile> {
  const safePath = validateReadPath(path);
  assertDocumentExtension(safePath, extension);
  await assertReadTarget(root, safePath);
  const target = resolve(root, safePath);
  const meta = await lstat(target);
  if (!meta.isFile() || meta.isSymbolicLink()) {
    throw new Error('Gateway rejected document target is not a regular file');
  }
  if (meta.size > MAX_DOCUMENT_FILE_BYTES) {
    throw new Error('Gateway rejected document input exceeds 32 MiB');
  }
  const bytes = await readFile(target);
  return {
    safePath,
    target,
    bytes,
    sha256: documentSha256(bytes),
  };
}

async function createDocumentFile(
  root: string,
  path: string,
  extension: '.docx' | '.xlsx' | '.pdf',
  bytes: Uint8Array,
  assertEffectAllowed: () => void,
): Promise<object> {
  const safePath = validateReadPath(path);
  assertDocumentExtension(safePath, extension);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_DOCUMENT_FILE_BYTES) {
    throw new Error('Gateway rejected generated document size');
  }

  assertEffectAllowed();
  await assertCreateTarget(root, safePath);
  const target = resolve(root, safePath);
  const temp = join(dirname(target), '.' + basename(target) + '.wag-' + randomUUID() + '.tmp');

  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    assertEffectAllowed();
    await assertCreateTarget(root, safePath);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    path: safePath,
    size_bytes: bytes.byteLength,
    sha256: documentSha256(bytes),
    created: true,
  };
}

async function replaceDocumentFile(
  root: string,
  path: string,
  extension: '.docx' | '.xlsx' | '.pdf',
  expectedSha256: string,
  nextBytes: Uint8Array,
  assertEffectAllowed: () => void,
): Promise<object> {
  assertExpectedSha256(expectedSha256);
  const current = await readDocumentFile(root, path, extension);
  if (current.sha256 !== expectedSha256) {
    throw new Error('Gateway denied document edit because SHA-256 changed');
  }
  if (nextBytes.byteLength < 1 || nextBytes.byteLength > MAX_DOCUMENT_FILE_BYTES) {
    throw new Error('Gateway rejected generated document size');
  }

  const temp = join(
    dirname(current.target),
    '.' + basename(current.target) + '.wag-' + randomUUID() + '.tmp',
  );

  try {
    assertEffectAllowed();
    await writeFile(temp, nextBytes, { flag: 'wx', mode: 0o600 });
    const liveBytes = await readFile(current.target);
    if (documentSha256(liveBytes) !== expectedSha256) {
      throw new Error('Gateway denied document edit because SHA-256 changed');
    }
    assertEffectAllowed();
    await rename(temp, current.target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    path: current.safePath,
    before_sha256: expectedSha256,
    after_sha256: documentSha256(nextBytes),
    size_bytes: nextBytes.byteLength,
    replaced: true,
  };
}

function redactDocxInspection(result: ReturnType<typeof inspectDocx>): object {
  let redacted = false;
  const paragraphs = result.paragraphs.map((value) => {
    const next = redactSecrets(value);
    if (next !== value) redacted = true;
    return next;
  });
  return { ...result, paragraphs, redacted };
}

function redactXlsxInspection(result: ReturnType<typeof inspectXlsx>): object {
  let redacted = false;
  const sheets = result.sheets.map((sheet) => ({
    ...sheet,
    cells: sheet.cells.map((cell) => {
      let value = cell.value;
      let formula = cell.formula;

      if (typeof value === 'string') {
        const next = redactSecrets(value);
        if (next !== value) redacted = true;
        value = next;
      }
      if (formula !== undefined) {
        const next = redactSecrets(formula);
        if (next !== formula) redacted = true;
        formula = next;
      }

      return {
        ...cell,
        value,
        ...(formula === undefined ? {} : { formula }),
      };
    }),
  }));

  return { ...result, sheets, redacted };
}

export function createLocalMachineDocumentContext(options: {
  resolveRoot: (workspaceId: string) => Promise<string>;
  assertEffectAllowed: () => void;
}): LocalMachineDocumentContext {
  const { resolveRoot, assertEffectAllowed } = options;

  return {
    async inspectDocx(workspaceId, path, inspectOptions = {}) {
      const root = await resolveRoot(workspaceId);
      const current = await readDocumentFile(root, path, '.docx');
      return {
        path: current.safePath,
        size_bytes: current.bytes.byteLength,
        ...redactDocxInspection(inspectDocx(current.bytes, inspectOptions)),
      };
    },

    async createDocx(workspaceId, path, paragraphs) {
      const root = await resolveRoot(workspaceId);
      const bytes = createDocx(paragraphs);
      return createDocumentFile(root, path, '.docx', bytes, assertEffectAllowed);
    },

    async replaceDocxText(
      workspaceId,
      path,
      expectedSha256,
      find,
      replacement,
      replaceAll = true,
    ) {
      const root = await resolveRoot(workspaceId);
      const current = await readDocumentFile(root, path, '.docx');
      if (current.sha256 !== expectedSha256) {
        throw new Error('Gateway denied document edit because SHA-256 changed');
      }
      const result = replaceDocxText(current.bytes, find, replacement, replaceAll);
      const committed = await replaceDocumentFile(
        root,
        path,
        '.docx',
        expectedSha256,
        result.bytes,
        assertEffectAllowed,
      );
      return {
        ...committed,
        replacements: result.replacements,
      };
    },

    async inspectXlsx(workspaceId, path, inspectOptions = {}) {
      const root = await resolveRoot(workspaceId);
      const current = await readDocumentFile(root, path, '.xlsx');
      return {
        path: current.safePath,
        size_bytes: current.bytes.byteLength,
        ...redactXlsxInspection(inspectXlsx(current.bytes, inspectOptions)),
      };
    },

    async createXlsx(workspaceId, path, sheets) {
      const root = await resolveRoot(workspaceId);
      const bytes = createXlsx(sheets);
      return createDocumentFile(root, path, '.xlsx', bytes, assertEffectAllowed);
    },

    async setXlsxCells(workspaceId, path, expectedSha256, sheet, cells) {
      const root = await resolveRoot(workspaceId);
      const current = await readDocumentFile(root, path, '.xlsx');
      if (current.sha256 !== expectedSha256) {
        throw new Error('Gateway denied document edit because SHA-256 changed');
      }
      const result = setXlsxCells(current.bytes, sheet, cells);
      const committed = await replaceDocumentFile(
        root,
        path,
        '.xlsx',
        expectedSha256,
        result.bytes,
        assertEffectAllowed,
      );
      return {
        ...committed,
        updated_cells: result.updatedCells,
      };
    },

    async createPdf(workspaceId, path, pages, pdfOptions = {}) {
      const root = await resolveRoot(workspaceId);
      const result = await createTextPdf(pages, pdfOptions);
      const committed = await createDocumentFile(
        root,
        path,
        '.pdf',
        result.bytes,
        assertEffectAllowed,
      );
      return {
        ...committed,
        page_count: result.pageCount,
      };
    },

    async overlayPdfText(workspaceId, path, expectedSha256, overlayOptions) {
      const root = await resolveRoot(workspaceId);
      const current = await readDocumentFile(root, path, '.pdf');
      if (current.sha256 !== expectedSha256) {
        throw new Error('Gateway denied document edit because SHA-256 changed');
      }
      const result = await overlayPdfText(current.bytes, overlayOptions);
      const committed = await replaceDocumentFile(
        root,
        path,
        '.pdf',
        expectedSha256,
        result.bytes,
        assertEffectAllowed,
      );
      return {
        ...committed,
        page_count: result.pageCount,
      };
    },
  };
}
