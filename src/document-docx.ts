import {
  assertXmlText,
  decodeXmlText,
  documentSha256,
  escapeXmlText,
  openSafeZip,
  repackSafeZip,
  unzipText,
  zipText,
} from './document-zip.js';

const DOCUMENT_XML = 'word/document.xml';
const MAX_DOCX_PARAGRAPHS = 10_000;
const MAX_DOCX_TEXT_BYTES = 1024 * 1024;
const DEFAULT_INSPECT_PARAGRAPHS = 200;
const DEFAULT_INSPECT_CHARS = 64 * 1024;
const MAX_REPLACEMENTS = 1_000;

export interface DocxInspectOptions {
  maxParagraphs?: number;
  maxChars?: number;
}

export interface DocxInspectResult {
  format: 'docx';
  sha256: string;
  paragraphCount: number;
  tableCount: number;
  paragraphs: string[];
  chars: number;
  truncated: boolean;
}

export interface DocxReplaceResult {
  bytes: Uint8Array;
  replacements: number;
  beforeSha256: string;
  afterSha256: string;
}

interface RunText {
  start: number;
  end: number;
  xml: string;
  text: string;
}

function paragraphText(paragraphXml: string): string {
  const values: string[] = [];
  const regex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  for (const match of paragraphXml.matchAll(regex)) {
    values.push(decodeXmlText(match[1] ?? ''));
  }
  return values.join('');
}

function paragraphsFromDocument(xml: string): string[] {
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)]
    .map((match) => match[0]);
  if (paragraphs.length > MAX_DOCX_PARAGRAPHS) {
    throw new Error('Gateway rejected DOCX paragraph count');
  }
  return paragraphs;
}

function runText(runXml: string): string {
  const values: string[] = [];
  for (const match of runXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    values.push(decodeXmlText(match[1] ?? ''));
  }
  return values.join('');
}

function runsFromParagraph(paragraphXml: string): RunText[] {
  const runs: RunText[] = [];
  const regex = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  for (const match of paragraphXml.matchAll(regex)) {
    const xml = match[0];
    const text = runText(xml);
    if (!text) continue;
    runs.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + xml.length,
      xml,
      text,
    });
  }
  return runs;
}

function xmlTextElement(value: string, attributes = ''): string {
  const needsPreserve = /^\s|\s$/.test(value);
  const preserve = needsPreserve && !/\bxml:space=/.test(attributes)
    ? ' xml:space="preserve"'
    : '';
  const cleanAttributes = attributes ? ' ' + attributes.trim() : '';
  return '<w:t' + cleanAttributes + preserve + '>' + escapeXmlText(value) + '</w:t>';
}

function replaceRunText(runXml: string, value: string): string {
  const matches = [...runXml.matchAll(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
  if (matches.length === 0) return runXml;

  let updated = runXml;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const replacement = index === 0
      ? xmlTextElement(value, (match[1] ?? '').trim())
      : '';
    updated = updated.slice(0, start) + replacement + updated.slice(end);
  }
  return updated;
}

function replaceOneInParagraph(
  paragraphXml: string,
  needle: string,
  replacement: string,
  fromEnd: boolean,
): { xml: string; replaced: boolean } {
  const runs = runsFromParagraph(paragraphXml);
  if (runs.length === 0) return { xml: paragraphXml, replaced: false };

  const full = runs.map((run) => run.text).join('');
  const matchStart = fromEnd ? full.lastIndexOf(needle) : full.indexOf(needle);
  if (matchStart < 0) return { xml: paragraphXml, replaced: false };
  const matchEnd = matchStart + needle.length;

  let cursor = 0;
  let startRun = -1;
  let endRun = -1;
  let startOffset = 0;
  let endOffset = 0;

  for (let index = 0; index < runs.length; index += 1) {
    const next = cursor + runs[index]!.text.length;
    if (startRun < 0 && matchStart >= cursor && matchStart < next) {
      startRun = index;
      startOffset = matchStart - cursor;
    }
    if (matchEnd > cursor && matchEnd <= next) {
      endRun = index;
      endOffset = matchEnd - cursor;
      break;
    }
    cursor = next;
  }

  if (startRun < 0 || endRun < 0) {
    throw new Error('Gateway rejected DOCX text mapping ambiguity');
  }

  const replacements = new Map<number, string>();
  if (startRun === endRun) {
    const text = runs[startRun]!.text;
    replacements.set(
      startRun,
      text.slice(0, startOffset) + replacement + text.slice(endOffset),
    );
  } else {
    const startText = runs[startRun]!.text;
    const endText = runs[endRun]!.text;
    replacements.set(startRun, startText.slice(0, startOffset) + replacement);
    for (let index = startRun + 1; index < endRun; index += 1) {
      replacements.set(index, '');
    }
    replacements.set(endRun, endText.slice(endOffset));
  }

  let updated = paragraphXml;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const replacementText = replacements.get(index);
    if (replacementText === undefined) continue;
    const run = runs[index]!;
    updated = updated.slice(0, run.start)
      + replaceRunText(run.xml, replacementText)
      + updated.slice(run.end);
  }

  return { xml: updated, replaced: true };
}

export function inspectDocx(
  bytes: Uint8Array,
  options: DocxInspectOptions = {},
): DocxInspectResult {
  const archive = openSafeZip(bytes, 'DOCX');
  const entry = archive.entries[DOCUMENT_XML];
  if (!entry) throw new Error('Gateway rejected DOCX missing word/document.xml');

  const xml = unzipText(entry, 'DOCX document');
  const paragraphs = paragraphsFromDocument(xml);
  const maxParagraphs = Math.min(
    Math.max(options.maxParagraphs ?? DEFAULT_INSPECT_PARAGRAPHS, 1),
    1_000,
  );
  const maxChars = Math.min(
    Math.max(options.maxChars ?? DEFAULT_INSPECT_CHARS, 1),
    256 * 1024,
  );

  const output: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const paragraph of paragraphs) {
    if (output.length >= maxParagraphs) {
      truncated = true;
      break;
    }
    const text = paragraphText(paragraph);
    if (chars + text.length > maxChars) {
      const remaining = Math.max(0, maxChars - chars);
      output.push(text.slice(0, remaining));
      chars += Math.min(text.length, remaining);
      truncated = true;
      break;
    }
    output.push(text);
    chars += text.length;
  }

  return {
    format: 'docx',
    sha256: documentSha256(bytes),
    paragraphCount: paragraphs.length,
    tableCount: (xml.match(/<w:tbl(?:\s|>)/g) ?? []).length,
    paragraphs: output,
    chars,
    truncated,
  };
}

export function createDocx(paragraphs: readonly string[]): Uint8Array {
  if (!Array.isArray(paragraphs) || paragraphs.length < 1 || paragraphs.length > 1_000) {
    throw new Error('Gateway rejected DOCX paragraph count');
  }

  let textBytes = 0;
  const body = paragraphs.map((paragraph) => {
    if (typeof paragraph !== 'string') throw new Error('Gateway rejected DOCX paragraph');
    assertXmlText(paragraph, 'DOCX paragraph', 64 * 1024);
    textBytes += Buffer.byteLength(paragraph, 'utf8');
    if (textBytes > MAX_DOCX_TEXT_BYTES) throw new Error('Gateway rejected DOCX text size');
    const preserve = /^\s|\s$/.test(paragraph) ? ' xml:space="preserve"' : '';
    return '<w:p><w:r><w:t' + preserve + '>'
      + escapeXmlText(paragraph)
      + '</w:t></w:r></w:p>';
  }).join('');

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + body
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
    + '</w:body></w:document>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" '
    + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" '
    + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    + 'Target="word/document.xml"/>'
    + '</Relationships>';

  return repackSafeZip({
    '[Content_Types].xml': zipText(contentTypes),
    '_rels/.rels': zipText(rootRels),
    [DOCUMENT_XML]: zipText(documentXml),
  });
}

export function replaceDocxText(
  bytes: Uint8Array,
  find: string,
  replacement: string,
  replaceAll = true,
): DocxReplaceResult {
  if (!find || Buffer.byteLength(find, 'utf8') > 8 * 1024) {
    throw new Error('Gateway rejected DOCX find text');
  }
  assertXmlText(replacement, 'DOCX replacement text', 64 * 1024);
  if (find === replacement) {
    return {
      bytes,
      replacements: 0,
      beforeSha256: documentSha256(bytes),
      afterSha256: documentSha256(bytes),
    };
  }

  const archive = openSafeZip(bytes, 'DOCX');
  const entry = archive.entries[DOCUMENT_XML];
  if (!entry) throw new Error('Gateway rejected DOCX missing word/document.xml');
  let xml = unzipText(entry, 'DOCX document');
  paragraphsFromDocument(xml);

  let replacements = 0;
  const paragraphRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  const originalParagraphs = [...xml.matchAll(paragraphRegex)];
  for (let index = originalParagraphs.length - 1; index >= 0; index -= 1) {
    const match = originalParagraphs[index]!;
    let paragraph = match[0];
    let changed = 0;

    if (replaceAll) {
      while (changed < MAX_REPLACEMENTS) {
        const result = replaceOneInParagraph(paragraph, find, replacement, false);
        if (!result.replaced) break;
        paragraph = result.xml;
        changed += 1;
      }
      if (changed >= MAX_REPLACEMENTS && paragraphText(paragraph).includes(find)) {
        throw new Error('Gateway rejected DOCX replacement count');
      }
    } else if (replacements === 0) {
      const result = replaceOneInParagraph(paragraph, find, replacement, false);
      if (result.replaced) {
        paragraph = result.xml;
        changed = 1;
      }
    }

    if (changed > 0) {
      const start = match.index ?? 0;
      xml = xml.slice(0, start) + paragraph + xml.slice(start + match[0].length);
      replacements += changed;
      if (!replaceAll) break;
    }
  }

  assertXmlText(xml, 'DOCX document XML', MAX_DOCUMENT_XML_BYTES);
  const updated = { ...archive.entries, [DOCUMENT_XML]: zipText(xml) };
  const output = repackSafeZip(updated);
  return {
    bytes: output,
    replacements,
    beforeSha256: documentSha256(bytes),
    afterSha256: documentSha256(output),
  };
}

const MAX_DOCUMENT_XML_BYTES = 16 * 1024 * 1024;
