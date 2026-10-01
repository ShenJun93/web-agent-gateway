import { PDFDocument, StandardFonts } from 'pdf-lib';
import { documentSha256 } from './document-zip.js';

const MAX_INPUT_PDF_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_PDF_BYTES = 32 * 1024 * 1024;
const MAX_CREATE_PAGES = 100;
const MAX_PDF_TEXT_BYTES = 1024 * 1024;
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

export interface PdfTextOptions {
  fontSize?: number;
  margin?: number;
}

export interface PdfOverlayOptions {
  page: number;
  text: string;
  x?: number;
  y?: number;
  fontSize?: number;
}

export interface PdfUpdateResult {
  bytes: Uint8Array;
  pageCount: number;
  beforeSha256?: string;
  afterSha256: string;
}

function validateText(value: string, label: string, maxBytes: number): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error('Gateway rejected ' + label + ' size');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      throw new Error('Gateway rejected ' + label + ' control character');
    }
  }
}

function fontSize(value: number | undefined): number {
  const size = value ?? 11;
  if (!Number.isFinite(size) || size < 6 || size > 48) {
    throw new Error('Gateway rejected PDF font size');
  }
  return size;
}

function marginSize(value: number | undefined): number {
  const margin = value ?? 54;
  if (!Number.isFinite(margin) || margin < 18 || margin > 144) {
    throw new Error('Gateway rejected PDF margin');
  }
  return margin;
}

function breakLongToken(
  token: string,
  maxWidth: number,
  measure: (value: string) => number,
): string[] {
  if (measure(token) <= maxWidth) return [token];
  const result: string[] = [];
  let current = '';
  for (const char of token) {
    const next = current + char;
    if (current && measure(next) > maxWidth) {
      result.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) result.push(current);
  return result;
}

function wrapText(
  value: string,
  maxWidth: number,
  measure: (value: string) => number,
): string[] {
  const lines: string[] = [];
  for (const sourceLine of value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    if (!sourceLine) {
      lines.push('');
      continue;
    }
    const words = sourceLine.split(/\s+/);
    let current = '';
    for (const word of words) {
      for (const token of breakLongToken(word, maxWidth, measure)) {
        const next = current ? current + ' ' + token : token;
        if (current && measure(next) > maxWidth) {
          lines.push(current);
          current = token;
        } else {
          current = next;
        }
      }
    }
    lines.push(current);
  }
  return lines;
}

async function loadWritablePdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (bytes.byteLength < 5 || bytes.byteLength > MAX_INPUT_PDF_BYTES) {
    throw new Error('Gateway rejected PDF input size');
  }
  try {
    const pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    if (pdf.isEncrypted) throw new Error('encrypted');
    return pdf;
  } catch {
    throw new Error('Gateway rejected encrypted or malformed PDF');
  }
}

async function saveBounded(pdf: PDFDocument): Promise<Uint8Array> {
  const output = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
  if (output.byteLength > MAX_OUTPUT_PDF_BYTES) {
    throw new Error('Gateway rejected generated PDF size');
  }
  return output;
}

export async function createTextPdf(
  pages: readonly string[],
  options: PdfTextOptions = {},
): Promise<PdfUpdateResult> {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_CREATE_PAGES) {
    throw new Error('Gateway rejected PDF page count');
  }
  let textBytes = 0;
  for (const page of pages) {
    validateText(page, 'PDF page text', MAX_PDF_TEXT_BYTES);
    textBytes += Buffer.byteLength(page, 'utf8');
  }
  if (textBytes > MAX_PDF_TEXT_BYTES) throw new Error('Gateway rejected PDF text size');

  const size = fontSize(options.fontSize);
  const margin = marginSize(options.margin);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const maxWidth = A4_WIDTH - margin * 2;
  const lineHeight = size * 1.25;
  const maxLines = Math.max(1, Math.floor((A4_HEIGHT - margin * 2) / lineHeight));

  for (const pageText of pages) {
    const wrapped = wrapText(
      pageText,
      maxWidth,
      (value) => font.widthOfTextAtSize(value, size),
    );
    if (wrapped.length > maxLines) {
      throw new Error('Gateway rejected PDF page text overflow; split content into more pages');
    }
    const page = pdf.addPage([A4_WIDTH, A4_HEIGHT]);
    let y = A4_HEIGHT - margin - size;
    for (const line of wrapped) {
      if (line) page.drawText(line, { x: margin, y, size, font });
      y -= lineHeight;
    }
  }

  const output = await saveBounded(pdf);
  return {
    bytes: output,
    pageCount: pdf.getPageCount(),
    afterSha256: documentSha256(output),
  };
}

export async function overlayPdfText(
  bytes: Uint8Array,
  options: PdfOverlayOptions,
): Promise<PdfUpdateResult> {
  validateText(options.text, 'PDF overlay text', 64 * 1024);
  const size = fontSize(options.fontSize);
  if (!Number.isInteger(options.page) || options.page < 1 || options.page > 1_000_000) {
    throw new Error('Gateway rejected PDF overlay page');
  }

  const pdf = await loadWritablePdf(bytes);
  const pages = pdf.getPages();
  if (options.page > pages.length) throw new Error('Gateway rejected PDF overlay page');
  const page = pages[options.page - 1]!;
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const { width, height } = page.getSize();
  const x = options.x ?? 54;
  const y = options.y ?? (height - 72);

  if (!Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || y < 0 || x > width || y > height) {
    throw new Error('Gateway rejected PDF overlay coordinates');
  }

  const maxWidth = Math.max(1, width - x - 18);
  const lines = wrapText(options.text, maxWidth, (value) => font.widthOfTextAtSize(value, size));
  const lineHeight = size * 1.25;
  if (lines.length > 200 || y - ((lines.length - 1) * lineHeight) < 0) {
    throw new Error('Gateway rejected PDF overlay text bounds');
  }

  let currentY = y;
  for (const line of lines) {
    if (line) page.drawText(line, { x, y: currentY, size, font });
    currentY -= lineHeight;
  }

  const output = await saveBounded(pdf);
  return {
    bytes: output,
    pageCount: pages.length,
    beforeSha256: documentSha256(bytes),
    afterSha256: documentSha256(output),
  };
}
