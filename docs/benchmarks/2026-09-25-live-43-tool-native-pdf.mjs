import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const runtimeRoot = 'E:/WAG-Runtime/5b6ab4aab5ef';
const configPath = 'E:/AI-BROWSER/wag-acceptance/wag-live.config.json';
const root = 'E:/WAG-Acceptance/pdf-live-86c99e8275ca';

function pdfEscape(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function makePdf(pageTexts) {
  const pageCount = pageTexts.length;
  const fontId = 3 + pageCount * 2;
  const objects = new Map();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pageTexts.map((_text, index) => String(3 + index * 2) + ' 0 R').join(' ');
  objects.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  pageTexts.forEach((text, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const stream = `BT /F1 12 Tf 72 720 Td (${pdfEscape(text)}) Tj ET`;
    objects.set(pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`);
  });
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let id = 1; id <= fontId; id += 1) {
    offsets[id] = Buffer.byteLength(body, 'ascii');
    body += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id += 1) {
    body += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
  }
  body += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

const mod = async (name) => import(pathToFileURL(runtimeRoot + '/dist/' + name).href);
const { loadPrivateGatewayConfig } = await mod('private-config.js');
const { startRepositoryEngineeringRuntime } = await mod('repository-engineering-runtime.js');

await mkdir(root, { recursive: true });
await writeFile(root + '/sample.pdf', makePdf([
  'Live PDF page one secret=live-pdf-secret',
  'Live PDF page two needle',
]));

const config = await loadPrivateGatewayConfig(configPath);
const engineering = await startRepositoryEngineeringRuntime(config, {
  startOperatorServer: async () => ({
    origin: 'http://127.0.0.1:1',
    bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=live-pdf-unused',
    close: async () => {},
  }),
});

try {
  const machine = engineering.machineContext;
  if (!machine) throw new Error('machineContext missing from deployed runtime');
  const opened = await machine.open(root);
  const workspaceId = opened.workspace_id;

  const first = await machine.extractPdf(workspaceId, 'sample.pdf', {
    startPage: 1,
    maxPages: 1,
    maxChars: 4096,
  });
  const second = await machine.extractPdf(workspaceId, 'sample.pdf', {
    startPage: 2,
    maxPages: 5,
    maxChars: 4096,
  });
  const fallback = await machine.read(workspaceId, 'sample.pdf');

  const ok = first.mime_type === 'application/pdf'
    && first.page_count === 2
    && first.extracted_pages === 1
    && first.has_more === true
    && first.redacted === true
    && /secret=<REDACTED>/i.test(first.content)
    && second.start_page === 2
    && second.has_more === false
    && /Live PDF page two needle/.test(second.content)
    && fallback.mime_type === 'application/pdf'
    && fallback.page_count === 2
    && /Live PDF page one/.test(fallback.content)
    && /Live PDF page two needle/.test(fallback.content);

  if (!ok) throw new Error('live PDF acceptance mismatch');

  console.log(JSON.stringify({
    state: 'PASS',
    runtimeRoot,
    sourceHead: '5b6ab4aab5ef7d398e97009e3c3d3e9dbefbe920',
    workspace: opened,
    first,
    second,
    fallback: {
      mime_type: fallback.mime_type,
      page_count: fallback.page_count,
      extracted_pages: fallback.extracted_pages,
      has_more: fallback.has_more,
      redacted: fallback.redacted,
      raw_sha256: fallback.raw_sha256,
      content: fallback.content,
    },
  }, null, 2));
} finally {
  await engineering.close();
}
