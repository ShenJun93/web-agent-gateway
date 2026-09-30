import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { createDocx, inspectDocx, replaceDocxText } from '../src/document-docx.js';
import { createTextPdf, overlayPdfText } from '../src/document-pdf.js';
import {
  createXlsx,
  inspectXlsx,
  setXlsxCells,
} from '../src/document-xlsx.js';
import {
  inspectZipBounds,
  openSafeZip,
  repackSafeZip,
  unzipText,
  zipText,
} from '../src/document-zip.js';
import { extractPdfText } from '../src/pdf-text-extractor.js';

test('document ZIP preflight rejects traversal entries and extreme expansion ratios', () => {
  const traversal = zipSync({ '../outside.txt': strToU8('nope') });
  assert.throws(() => inspectZipBounds(traversal), /traversal/);

  const bomb = zipSync({ 'word/document.xml': new Uint8Array(2 * 1024 * 1024) }, { level: 9 });
  assert.throws(() => inspectZipBounds(bomb), /compression ratio/);
});

test('DOCX create/inspect round trip is bounded and stable', () => {
  const bytes = createDocx(['Title', ' hello world ']);
  const inspected = inspectDocx(bytes);
  assert.equal(inspected.format, 'docx');
  assert.equal(inspected.paragraphCount, 2);
  assert.deepEqual(inspected.paragraphs, ['Title', ' hello world ']);
  assert.match(inspected.sha256, /^[a-f0-9]{64}$/);
});

test('DOCX replacement spans split runs and preserves untouched package entries', () => {
  const base = createDocx(['alpha beta', 'untouched']);
  const archive = openSafeZip(base, 'DOCX');
  const originalRels = Buffer.from(archive.entries['_rels/.rels']!);
  const document = unzipText(archive.entries['word/document.xml']!, 'DOCX document');
  const split = document.replace(
    '<w:r><w:t>alpha beta</w:t></w:r>',
    '<w:r><w:rPr><w:b/></w:rPr><w:t>alpha </w:t></w:r><w:r><w:t>beta</w:t></w:r>',
  );
  const splitBytes = repackSafeZip({
    ...archive.entries,
    'word/document.xml': zipText(split),
  });

  const result = replaceDocxText(splitBytes, 'alpha beta', 'GAMMA', true);
  assert.equal(result.replacements, 1);
  const inspected = inspectDocx(result.bytes);
  assert.deepEqual(inspected.paragraphs, ['GAMMA', 'untouched']);

  const updated = openSafeZip(result.bytes, 'DOCX');
  assert.deepEqual(Buffer.from(updated.entries['_rels/.rels']!), originalRels);
  const updatedDocument = unzipText(updated.entries['word/document.xml']!, 'DOCX document');
  assert.match(updatedDocument, /<w:rPr><w:b\/><\/w:rPr><w:t>GAMMA<\/w:t>/);
});

test('XLSX create/inspect supports bounded native values without ExcelJS', () => {
  const bytes = createXlsx([
    {
      name: 'Data',
      cells: [
        { cell: 'A1', value: 'name' },
        { cell: 'B1', value: 7 },
        { cell: 'C1', value: true },
      ],
    },
  ]);
  const inspected = inspectXlsx(bytes);
  assert.equal(inspected.sheetCount, 1);
  assert.deepEqual(inspected.sheets[0]!.cells, [
    { cell: 'A1', value: 'name' },
    { cell: 'B1', value: 7 },
    { cell: 'C1', value: true },
  ]);
});

test('XLSX set-cells preserves style on patched cell and untouched formulas/package entries', () => {
  const base = createXlsx([
    {
      name: 'Data',
      cells: [
        { cell: 'A1', value: 'old' },
        { cell: 'B1', value: 2 },
        { cell: 'C1', value: 3 },
      ],
    },
  ]);
  const archive = openSafeZip(base, 'XLSX');
  const relsBefore = Buffer.from(archive.entries['_rels/.rels']!);
  let sheet = unzipText(archive.entries['xl/worksheets/sheet1.xml']!, 'XLSX worksheet');
  sheet = sheet
    .replace('<c r="A1" t="inlineStr">', '<c r="A1" s="5" t="inlineStr">')
    .replace('<c r="C1"><v>3</v></c>', '<c r="C1"><f>B1+1</f><v>3</v></c>');
  const styled = repackSafeZip({
    ...archive.entries,
    'xl/worksheets/sheet1.xml': zipText(sheet),
  });

  const result = setXlsxCells(styled, 'Data', [
    { cell: 'A1', value: 'new' },
    { cell: 'B2', value: 9 },
  ]);
  assert.equal(result.updatedCells, 2);
  const updated = openSafeZip(result.bytes, 'XLSX');
  assert.deepEqual(Buffer.from(updated.entries['_rels/.rels']!), relsBefore);
  const updatedSheet = unzipText(updated.entries['xl/worksheets/sheet1.xml']!, 'XLSX worksheet');
  assert.match(updatedSheet, /<c r="A1" s="5" t="inlineStr">/);
  assert.match(updatedSheet, /<c r="C1"><f>B1\+1<\/f><v>3<\/v><\/c>/);

  const inspected = inspectXlsx(result.bytes);
  const cells = inspected.sheets[0]!.cells;
  assert.deepEqual(cells.find((cell) => cell.cell === 'A1'), { cell: 'A1', value: 'new', style: 5 });
  assert.deepEqual(cells.find((cell) => cell.cell === 'B2'), { cell: 'B2', value: 9 });
  assert.deepEqual(
    cells.find((cell) => cell.cell === 'C1'),
    { cell: 'C1', value: 3, formula: 'B1+1' },
  );
});

test('PDF create and overlay remain readable through the accepted extractor', async () => {
  const created = await createTextPdf(['hello PDF']);
  assert.equal(created.pageCount, 1);
  const first = await extractPdfText(created.bytes, { startPage: 1, maxPages: 1, maxChars: 4096 });
  assert.match(first.pages.map((page) => page.text).join('\n'), /hello PDF/);

  const overlaid = await overlayPdfText(created.bytes, {
    page: 1,
    text: 'overlay marker',
    x: 72,
    y: 700,
    fontSize: 12,
  });
  assert.equal(overlaid.pageCount, 1);
  assert.notEqual(overlaid.afterSha256, created.afterSha256);
  const second = await extractPdfText(overlaid.bytes, { startPage: 1, maxPages: 1, maxChars: 4096 });
  const extracted = second.pages.map((page) => page.text).join('\n');
  assert.match(extracted, /hello PDF/);
  assert.match(extracted, /overlay marker/);
});
