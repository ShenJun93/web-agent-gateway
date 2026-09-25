import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { createLocalMachineContext } from '../src/local-machine-runtime.js';
import { WorkspaceIdentityRegistry } from '../src/workspace-identity.js';

function pdfEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function makePdf(pageTexts: readonly string[]): Buffer {
  const pageCount = pageTexts.length;
  const fontId = 3 + pageCount * 2;
  const objects = new Map<number, string>();
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
  const offsets: number[] = [0];
  for (let id = 1; id <= fontId; id += 1) {
    offsets[id] = Buffer.byteLength(body, 'ascii');
    body += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${fontId + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let id = 1; id <= fontId; id += 1) {
    body += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
  }
  body += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-local-pdf-'));
  const root = await realpath(dir);
  const statePath = join(dir, 'state.sqlite');
  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const context = createLocalMachineContext({
    store,
    callerContext: createGatewayCallerContext({
      ownerId: 'owner_pdf',
      sessionId: 'session_pdf',
      adapterId: 'private.stdio.v1',
    }),
    workspaceIdentities: identities,
    killSwitch: () => false,
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { root, context };
}

test('local PDF extraction is bounded, paged, redacted and available through frozen file.read semantics', async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(join(root, 'sample.pdf'), makePdf([
    'Hello PDF page one secret=pdf-secret',
    'Second PDF page needle',
  ]));
  const opened = await context.open(root) as { workspace_id: string };

  const first = await context.extractPdf(opened.workspace_id, 'sample.pdf', {
    startPage: 1,
    maxPages: 1,
    maxChars: 4096,
  }) as {
    mime_type: string;
    page_count: number;
    extracted_pages: number;
    content: string;
    has_more: boolean;
    redacted: boolean;
    raw_sha256: string;
  };
  assert.equal(first.mime_type, 'application/pdf');
  assert.equal(first.page_count, 2);
  assert.equal(first.extracted_pages, 1);
  assert.match(first.content, /Hello PDF page one/);
  assert.match(first.content, /secret=<REDACTED>/i);
  assert.equal(first.has_more, true);
  assert.equal(first.redacted, true);
  assert.match(first.raw_sha256, /^[a-f0-9]{64}$/);

  const second = await context.extractPdf(opened.workspace_id, 'sample.pdf', {
    startPage: 2,
    maxPages: 5,
    maxChars: 4096,
  }) as { content: string; start_page: number; has_more: boolean };
  assert.equal(second.start_page, 2);
  assert.match(second.content, /Second PDF page needle/);
  assert.equal(second.has_more, false);

  const frozenRead = await context.read(opened.workspace_id, 'sample.pdf') as {
    mime_type: string;
    content: string;
    page_count: number;
  };
  assert.equal(frozenRead.mime_type, 'application/pdf');
  assert.equal(frozenRead.page_count, 2);
  assert.match(frozenRead.content, /Hello PDF page one/);
  assert.match(frozenRead.content, /Second PDF page needle/);

  await assert.rejects(
    () => context.read(opened.workspace_id, 'sample.pdf', { offset: 1, length: 1 }),
    /machine\.pdf\.extract/,
  );
});

test('explicit PDF extraction refuses non-PDF bytes', async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(join(root, 'not-a-pdf.pdf'), 'plain text\n', 'utf8');
  const opened = await context.open(root) as { workspace_id: string };
  await assert.rejects(
    () => context.extractPdf(opened.workspace_id, 'not-a-pdf.pdf'),
    /not a PDF/i,
  );
});
