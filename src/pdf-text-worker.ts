import { readFile } from 'node:fs/promises';
import { extractPdfText } from './pdf-text-extractor.js';

function integerArg(index: number, name: string): number {
  const value = Number(process.argv[index]);
  if (!Number.isSafeInteger(value)) throw new Error('invalid ' + name);
  return value;
}

const path = process.argv[2];
if (!path) throw new Error('missing PDF path');

try {
  const bytes = await readFile(path);
  const result = await extractPdfText(bytes, {
    startPage: integerArg(3, 'start page'),
    maxPages: integerArg(4, 'page limit'),
    maxChars: integerArg(5, 'character limit'),
  });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write('PDF_EXTRACT_ERROR:' + message.replace(/[\r\n]+/g, ' ') + '\n');
  process.exitCode = 1;
}
