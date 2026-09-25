import { createHash } from 'node:crypto';
import { getDocument, PasswordResponses } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfExtractOptions {
  startPage: number;
  maxPages: number;
  maxChars: number;
}

export interface PdfExtractPage {
  page: number;
  text: string;
}

export interface PdfExtractResult {
  pageCount: number;
  startPage: number;
  pages: PdfExtractPage[];
  chars: number;
  hasMore: boolean;
  truncated: boolean;
  sha256: string;
}

export async function extractPdfText(
  bytes: Uint8Array,
  options: PdfExtractOptions,
): Promise<PdfExtractResult> {
  if (bytes.length < 5 || new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error('not a PDF document');
  }
  if (!Number.isInteger(options.startPage) || options.startPage < 1) {
    throw new Error('invalid PDF start page');
  }
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1) {
    throw new Error('invalid PDF page limit');
  }
  if (!Number.isInteger(options.maxChars) || options.maxChars < 1) {
    throw new Error('invalid PDF character limit');
  }

  const loadingTask = getDocument({
    // pdfjs-dist intentionally rejects Node Buffer instances even though Buffer extends
    // Uint8Array. Copy into a plain Uint8Array so worker input is runtime-neutral.
    data: Uint8Array.from(bytes),
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: true,
    verbosity: 0,
  });

  try {
    loadingTask.onPassword = (_updatePassword: (password: string) => void, reason: number) => {
      const kind = reason === PasswordResponses.NEED_PASSWORD ? 'password required' : 'incorrect password';
      loadingTask.destroy().catch(() => undefined);
      throw new Error('encrypted PDF: ' + kind);
    };

    const doc = await loadingTask.promise;
    if (options.startPage > doc.numPages) {
      return {
        pageCount: doc.numPages,
        startPage: options.startPage,
        pages: [],
        chars: 0,
        hasMore: false,
        truncated: false,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }

    const endPage = Math.min(doc.numPages, options.startPage + options.maxPages - 1);
    const pages: PdfExtractPage[] = [];
    let chars = 0;
    let truncated = false;

    for (let pageNumber = options.startPage; pageNumber <= endPage; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const value = (item as { str?: string }).str ?? '';
        if (!value) continue;
        const separator = text.length === 0 ? '' : ((item as { hasEOL?: boolean }).hasEOL ? '\n' : ' ');
        const next = separator + value;
        const remaining = options.maxChars - chars;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        if (next.length > remaining) {
          text += next.slice(0, remaining);
          chars += remaining;
          truncated = true;
          break;
        }
        text += next;
        chars += next.length;
      }
      pages.push({ page: pageNumber, text: text.trim() });
      if (truncated) break;
    }

    const lastPage = pages.at(-1)?.page ?? options.startPage - 1;
    return {
      pageCount: doc.numPages,
      startPage: options.startPage,
      pages,
      chars,
      hasMore: truncated || lastPage < doc.numPages,
      truncated,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}
