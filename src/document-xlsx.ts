import {
  assertXmlText,
  decodeXmlText,
  documentSha256,
  escapeXmlAttribute,
  escapeXmlText,
  openSafeZip,
  repackSafeZip,
  unzipText,
  xmlAttribute,
  zipText,
} from './document-zip.js';

const WORKBOOK_XML = 'xl/workbook.xml';
const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels';
const SHARED_STRINGS = 'xl/sharedStrings.xml';
const MAX_SHEETS = 100;
const MAX_INSPECT_CELLS = 5_000;
const MAX_INSPECT_CHARS = 256 * 1024;
const MAX_WRITE_CELLS = 5_000;
const MAX_CELL_STRING_BYTES = 32 * 1024;
const MAX_XLSX_XML_BYTES = 16 * 1024 * 1024;
const MAX_EXCEL_ROW = 1_048_576;
const MAX_EXCEL_COLUMN = 16_384;

export type XlsxCellValue = string | number | boolean | null;

export interface XlsxCellInput {
  cell: string;
  value: XlsxCellValue;
}

export interface XlsxSheetInput {
  name: string;
  cells?: readonly XlsxCellInput[];
}

export interface XlsxInspectOptions {
  maxCells?: number;
  maxChars?: number;
}

export interface XlsxInspectCell {
  cell: string;
  value: string | number | boolean | null;
  formula?: string;
  style?: number;
}

export interface XlsxInspectSheet {
  name: string;
  cells: XlsxInspectCell[];
  truncated: boolean;
}

export interface XlsxInspectResult {
  format: 'xlsx';
  sha256: string;
  sheetCount: number;
  cellCount: number;
  sheets: XlsxInspectSheet[];
  truncated: boolean;
}

export interface XlsxUpdateResult {
  bytes: Uint8Array;
  updatedCells: number;
  beforeSha256: string;
  afterSha256: string;
}

interface SheetBinding {
  name: string;
  relationshipId: string;
  path: string;
}

interface CellRef {
  ref: string;
  column: number;
  row: number;
}

function hasInvalidControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

function validateSheetName(name: string): void {
  if (!name || name.length > 31 || hasInvalidControl(name)) {
    throw new Error('Gateway rejected XLSX sheet name');
  }
  for (const forbidden of ['[', ']', ':', '*', '?', '/', '\\']) {
    if (name.includes(forbidden)) throw new Error('Gateway rejected XLSX sheet name');
  }
  if (name.startsWith("'") || name.endsWith("'")) {
    throw new Error('Gateway rejected XLSX sheet name');
  }
}

function columnNumber(letters: string): number {
  let value = 0;
  for (const char of letters) {
    const code = char.charCodeAt(0);
    value = value * 26 + (code - 64);
  }
  return value;
}

function columnLetters(column: number): string {
  let value = column;
  let output = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function parseCellRef(value: string): CellRef {
  const normalized = value.toUpperCase();
  const match = normalized.match(/^([A-Z]{1,3})([1-9][0-9]{0,6})$/);
  if (!match) throw new Error('Gateway rejected XLSX cell reference');
  const column = columnNumber(match[1]!);
  const row = Number(match[2]!);
  if (column < 1 || column > MAX_EXCEL_COLUMN || row < 1 || row > MAX_EXCEL_ROW) {
    throw new Error('Gateway rejected XLSX cell bounds');
  }
  return { ref: columnLetters(column) + String(row), column, row };
}

function validateCellValue(value: XlsxCellValue): void {
  if (typeof value === 'string') {
    assertXmlText(value, 'XLSX cell string', MAX_CELL_STRING_BYTES);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Gateway rejected XLSX non-finite number');
    return;
  }
  if (typeof value === 'boolean' || value === null) return;
  throw new Error('Gateway rejected XLSX cell value');
}

function normalizeRelationshipTarget(target: string): string {
  const clean = target.replaceAll('\\', '/').replace(/^\/+/, '');
  const stack = ['xl'];
  for (const segment of clean.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length <= 1) throw new Error('Gateway rejected XLSX relationship traversal');
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  const path = stack.join('/');
  if (!path.startsWith('xl/')) throw new Error('Gateway rejected XLSX relationship target');
  return path;
}

function workbookBindings(entries: Record<string, Uint8Array>): SheetBinding[] {
  const workbook = entries[WORKBOOK_XML];
  const rels = entries[WORKBOOK_RELS];
  if (!workbook || !rels) throw new Error('Gateway rejected XLSX workbook structure');

  const workbookXml = unzipText(workbook, 'XLSX workbook');
  const relsXml = unzipText(rels, 'XLSX workbook relationships');

  const relationshipTargets = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\s+([^>]*?)\/?\s*>/g)) {
    const attrs = match[1] ?? '';
    const id = xmlAttribute(attrs, 'Id');
    const type = xmlAttribute(attrs, 'Type');
    const target = xmlAttribute(attrs, 'Target');
    if (!id || !target || !type?.endsWith('/worksheet')) continue;
    relationshipTargets.set(id, normalizeRelationshipTarget(target));
  }

  const bindings: SheetBinding[] = [];
  for (const match of workbookXml.matchAll(/<sheet\s+([^>]*?)\/?\s*>/g)) {
    const attrs = match[1] ?? '';
    const name = xmlAttribute(attrs, 'name');
    const relationshipId = xmlAttribute(attrs, 'r:id');
    if (!name || !relationshipId) throw new Error('Gateway rejected XLSX sheet metadata');
    validateSheetName(name);
    const path = relationshipTargets.get(relationshipId);
    if (!path || !entries[path]) throw new Error('Gateway rejected XLSX worksheet relationship');
    bindings.push({ name, relationshipId, path });
  }
  if (bindings.length < 1 || bindings.length > MAX_SHEETS) {
    throw new Error('Gateway rejected XLSX sheet count');
  }
  const names = new Set(bindings.map((binding) => binding.name.toLocaleLowerCase()));
  if (names.size !== bindings.length) throw new Error('Gateway rejected duplicate XLSX sheet name');
  return bindings;
}

function sharedStrings(entries: Record<string, Uint8Array>): string[] {
  const entry = entries[SHARED_STRINGS];
  if (!entry) return [];
  const xml = unzipText(entry, 'XLSX shared strings');
  const output: string[] = [];
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    const body = match[1] ?? '';
    const text = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((item) => decodeXmlText(item[1] ?? ''))
      .join('');
    output.push(text);
    if (output.length > 1_000_000) throw new Error('Gateway rejected XLSX shared string count');
  }
  return output;
}

function parseCellValue(
  cellXml: string,
  attrs: string,
  strings: readonly string[],
): XlsxInspectCell['value'] {
  const type = xmlAttribute(attrs, 't');
  if (type === 'inlineStr') {
    return [...cellXml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((match) => decodeXmlText(match[1] ?? ''))
      .join('');
  }

  const valueMatch = cellXml.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
  const raw = valueMatch ? decodeXmlText(valueMatch[1] ?? '') : '';
  if (type === 's') {
    const index = Number(raw);
    if (!Number.isSafeInteger(index) || index < 0 || index >= strings.length) {
      throw new Error('Gateway rejected XLSX shared string reference');
    }
    return strings[index]!;
  }
  if (type === 'b') return raw === '1';
  if (type === 'str') return raw;
  if (!raw) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : raw;
}

function inspectSheet(
  xml: string,
  name: string,
  strings: readonly string[],
  remainingCells: number,
  remainingChars: number,
): { result: XlsxInspectSheet; seenCells: number; seenChars: number } {
  const cells: XlsxInspectCell[] = [];
  let seenCells = 0;
  let seenChars = 0;
  let truncated = false;

  for (const match of xml.matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (seenCells >= remainingCells || seenChars >= remainingChars) {
      truncated = true;
      break;
    }
    const attrs = match[1] ?? '';
    const refRaw = xmlAttribute(attrs, 'r');
    if (!refRaw) continue;
    const ref = parseCellRef(refRaw).ref;
    const cellXml = match[0];
    const value = parseCellValue(cellXml, attrs, strings);
    const formulaMatch = cellXml.match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/);
    const formula = formulaMatch ? decodeXmlText(formulaMatch[1] ?? '') : undefined;
    const styleRaw = xmlAttribute(attrs, 's');
    const style = styleRaw === null ? undefined : Number(styleRaw);
    if (style !== undefined && (!Number.isSafeInteger(style) || style < 0)) {
      throw new Error('Gateway rejected XLSX style reference');
    }

    const charCost = typeof value === 'string' ? value.length : formula?.length ?? 0;
    if (seenChars + charCost > remainingChars) {
      truncated = true;
      break;
    }
    cells.push({
      cell: ref,
      value,
      ...(formula === undefined ? {} : { formula }),
      ...(style === undefined ? {} : { style }),
    });
    seenCells += 1;
    seenChars += charCost;
  }

  return { result: { name, cells, truncated }, seenCells, seenChars };
}

export function inspectXlsx(
  bytes: Uint8Array,
  options: XlsxInspectOptions = {},
): XlsxInspectResult {
  const archive = openSafeZip(bytes, 'XLSX');
  const bindings = workbookBindings(archive.entries);
  const strings = sharedStrings(archive.entries);
  const maxCells = Math.min(Math.max(options.maxCells ?? 1_000, 1), MAX_INSPECT_CELLS);
  const maxChars = Math.min(Math.max(options.maxChars ?? 64 * 1024, 1), MAX_INSPECT_CHARS);

  const sheets: XlsxInspectSheet[] = [];
  let cellCount = 0;
  let chars = 0;
  let truncated = false;
  for (const binding of bindings) {
    if (cellCount >= maxCells || chars >= maxChars) {
      truncated = true;
      break;
    }
    const xml = unzipText(archive.entries[binding.path]!, 'XLSX worksheet');
    const inspected = inspectSheet(
      xml,
      binding.name,
      strings,
      maxCells - cellCount,
      maxChars - chars,
    );
    sheets.push(inspected.result);
    cellCount += inspected.seenCells;
    chars += inspected.seenChars;
    truncated ||= inspected.result.truncated;
  }
  if (sheets.length < bindings.length) truncated = true;

  return {
    format: 'xlsx',
    sha256: documentSha256(bytes),
    sheetCount: bindings.length,
    cellCount,
    sheets,
    truncated,
  };
}

function cellXml(input: XlsxCellInput, preservedStyle?: string | null): string {
  const ref = parseCellRef(input.cell).ref;
  validateCellValue(input.value);
  const style = preservedStyle === null || preservedStyle === undefined
    ? ''
    : ' s="' + escapeXmlAttribute(preservedStyle) + '"';

  if (typeof input.value === 'string') {
    const preserve = /^\s|\s$/.test(input.value) ? ' xml:space="preserve"' : '';
    return '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t' + preserve + '>'
      + escapeXmlText(input.value) + '</t></is></c>';
  }
  if (typeof input.value === 'boolean') {
    return '<c r="' + ref + '"' + style + ' t="b"><v>'
      + (input.value ? '1' : '0') + '</v></c>';
  }
  if (typeof input.value === 'number') {
    return '<c r="' + ref + '"' + style + '><v>' + String(input.value) + '</v></c>';
  }
  return '<c r="' + ref + '"' + style + '/>';
}

function normalizeCellInputs(cells: readonly XlsxCellInput[]): Array<XlsxCellInput & CellRef> {
  if (!Array.isArray(cells) || cells.length > MAX_WRITE_CELLS) {
    throw new Error('Gateway rejected XLSX write cell count');
  }
  const values = new Map<string, XlsxCellInput & CellRef>();
  for (const input of cells) {
    if (!input || typeof input.cell !== 'string') throw new Error('Gateway rejected XLSX cell update');
    validateCellValue(input.value);
    const parsed = parseCellRef(input.cell);
    values.set(parsed.ref, { ...input, ...parsed });
  }
  return [...values.values()].sort((left, right) =>
    left.row - right.row || left.column - right.column);
}

function minimalSheetXml(cells: readonly XlsxCellInput[]): string {
  const normalized = normalizeCellInputs(cells);
  const rows = new Map<number, Array<XlsxCellInput & CellRef>>();
  for (const cell of normalized) {
    const row = rows.get(cell.row) ?? [];
    row.push(cell);
    rows.set(cell.row, row);
  }
  const body = [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([row, values]) =>
      '<row r="' + String(row) + '">'
      + values.map((value) => cellXml(value)).join('')
      + '</row>')
    .join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetData>' + body + '</sheetData></worksheet>';
}

function sheetNameEquals(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function replaceOrInsertCell(sheetXml: string, input: XlsxCellInput & CellRef): string {
  const refPattern = input.ref.replace(/[.*+?^$()|[\]\\]/g, '\\');
  const cellPattern = new RegExp(
    '<c\\s+([^>]*?\\br="' + refPattern + '"[^>]*?)(?:\\/>|>[\\s\\S]*?<\\/c>)',
  );
  const match = sheetXml.match(cellPattern);
  if (match) {
    const style = xmlAttribute(match[1] ?? '', 's');
    return sheetXml.replace(cellPattern, cellXml(input, style));
  }

  const rowPattern = new RegExp(
    '<row\\s+([^>]*?\\br="' + String(input.row) + '"[^>]*)>([\\s\\S]*?)<\\/row>',
  );
  const rowMatch = sheetXml.match(rowPattern);
  if (rowMatch) {
    const rowBody = rowMatch[2] ?? '';
    let insertAt = rowBody.length;
    for (const existing of rowBody.matchAll(/<c\s+([^>]*?\br="([^"]+)"[^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)) {
      const existingRef = parseCellRef(existing[2]!);
      if (existingRef.column > input.column) {
        insertAt = existing.index ?? rowBody.length;
        break;
      }
    }
    const updatedBody = rowBody.slice(0, insertAt) + cellXml(input) + rowBody.slice(insertAt);
    const updatedRow = '<row ' + (rowMatch[1] ?? '') + '>' + updatedBody + '</row>';
    return sheetXml.replace(rowPattern, updatedRow);
  }

  const sheetDataEnd = sheetXml.indexOf('</sheetData>');
  if (sheetDataEnd < 0) throw new Error('Gateway rejected XLSX worksheet missing sheetData');
  const rowXml = '<row r="' + String(input.row) + '">' + cellXml(input) + '</row>';
  return sheetXml.slice(0, sheetDataEnd) + rowXml + sheetXml.slice(sheetDataEnd);
}

export function createXlsx(sheets: readonly XlsxSheetInput[]): Uint8Array {
  if (!Array.isArray(sheets) || sheets.length < 1 || sheets.length > MAX_SHEETS) {
    throw new Error('Gateway rejected XLSX sheet count');
  }
  const seen = new Set<string>();
  let writeCells = 0;
  for (const sheet of sheets) {
    validateSheetName(sheet.name);
    const key = sheet.name.toLocaleLowerCase();
    if (seen.has(key)) throw new Error('Gateway rejected duplicate XLSX sheet name');
    seen.add(key);
    writeCells += sheet.cells?.length ?? 0;
    if (writeCells > MAX_WRITE_CELLS) throw new Error('Gateway rejected XLSX write cell count');
  }

  const contentOverrides: string[] = [];
  const workbookSheets: string[] = [];
  const relationships: string[] = [];
  const entries: Record<string, Uint8Array> = {};

  sheets.forEach((sheet, index) => {
    const number = index + 1;
    const path = 'xl/worksheets/sheet' + String(number) + '.xml';
    entries[path] = zipText(minimalSheetXml(sheet.cells ?? []));
    contentOverrides.push(
      '<Override PartName="/' + path + '" '
      + 'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    );
    workbookSheets.push(
      '<sheet name="' + escapeXmlAttribute(sheet.name) + '" sheetId="' + String(number)
      + '" r:id="rId' + String(number) + '"/>',
    );
    relationships.push(
      '<Relationship Id="rId' + String(number)
      + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
      + ' Target="worksheets/sheet' + String(number) + '.xml"/>',
    );
  });

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" '
    + 'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + contentOverrides.join('')
    + '</Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" '
    + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    + 'Target="xl/workbook.xml"/></Relationships>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets>' + workbookSheets.join('') + '</sheets></workbook>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + relationships.join('') + '</Relationships>';

  entries['[Content_Types].xml'] = zipText(contentTypes);
  entries['_rels/.rels'] = zipText(rootRels);
  entries[WORKBOOK_XML] = zipText(workbook);
  entries[WORKBOOK_RELS] = zipText(rels);
  return repackSafeZip(entries);
}

export function setXlsxCells(
  bytes: Uint8Array,
  sheetName: string,
  cells: readonly XlsxCellInput[],
): XlsxUpdateResult {
  validateSheetName(sheetName);
  const normalized = normalizeCellInputs(cells);
  if (normalized.length < 1) throw new Error('Gateway rejected empty XLSX cell update');

  const archive = openSafeZip(bytes, 'XLSX');
  const bindings = workbookBindings(archive.entries);
  const binding = bindings.find((item) => sheetNameEquals(item.name, sheetName));
  if (!binding) throw new Error('Gateway rejected unknown XLSX sheet');

  let xml = unzipText(archive.entries[binding.path]!, 'XLSX worksheet');
  if (Buffer.byteLength(xml, 'utf8') > MAX_XLSX_XML_BYTES) {
    throw new Error('Gateway rejected oversized XLSX worksheet XML');
  }
  for (const cell of normalized) {
    xml = replaceOrInsertCell(xml, cell);
  }
  if (Buffer.byteLength(xml, 'utf8') > MAX_XLSX_XML_BYTES) {
    throw new Error('Gateway rejected oversized XLSX worksheet XML');
  }

  const updated = { ...archive.entries, [binding.path]: zipText(xml) };
  const output = repackSafeZip(updated);
  return {
    bytes: output,
    updatedCells: normalized.length,
    beforeSha256: documentSha256(bytes),
    afterSha256: documentSha256(output),
  };
}
