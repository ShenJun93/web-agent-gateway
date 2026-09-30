import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDocx } from '../src/document-docx.js';
import { createLocalMachineDocumentContext } from '../src/local-machine-document-runtime.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'wag-document-runtime-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  let effects = 0;
  const context = createLocalMachineDocumentContext({
    resolveRoot: async (workspaceId) => {
      assert.equal(workspaceId, 'ws_doc');
      return root;
    },
    assertEffectAllowed: () => { effects += 1; },
  });
  return { root, context, effects: () => effects };
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('document create is new-path only and extension bounded', async (t) => {
  const { context, effects } = await fixture(t);

  const first = await context.createDocx('ws_doc', 'report.docx', ['hello']);
  assert.equal((first as { created?: boolean }).created, true);
  await assert.rejects(
    () => context.createDocx('ws_doc', 'report.docx', ['overwrite']),
    /existing creation target|already exists|create target|rejected/i,
  );
  await assert.rejects(
    () => context.createDocx('ws_doc', 'report.txt', ['wrong extension']),
    /document extension/,
  );
  assert.ok(effects() >= 2);
});

test('document edit rejects stale SHA and preserves the newer bytes', async (t) => {
  const { root, context } = await fixture(t);
  await context.createDocx('ws_doc', 'report.docx', ['version one']);
  const inspected = await context.inspectDocx('ws_doc', 'report.docx') as { sha256: string };
  const oldSha = inspected.sha256;

  const newer = createDocx(['version two']);
  await writeFile(join(root, 'report.docx'), newer);
  const newerSha = sha(newer);

  await assert.rejects(
    () => context.replaceDocxText(
      'ws_doc',
      'report.docx',
      oldSha,
      'version',
      'changed',
      true,
    ),
    /SHA-256 changed/,
  );

  const after = await readFile(join(root, 'report.docx'));
  assert.equal(sha(after), newerSha);
});

test('DOCX, XLSX and PDF mutations commit through the bounded same-path runtime', async (t) => {
  const { root, context } = await fixture(t);

  await context.createDocx('ws_doc', 'edit.docx', ['old value']);
  const docxBefore = await context.inspectDocx('ws_doc', 'edit.docx') as { sha256: string };
  const docxEdit = await context.replaceDocxText(
    'ws_doc', 'edit.docx', docxBefore.sha256, 'old', 'new', true,
  ) as { after_sha256: string; replacements: number };
  assert.equal(docxEdit.replacements, 1);
  const docxAfter = await context.inspectDocx('ws_doc', 'edit.docx') as { paragraphs: string[]; sha256: string };
  assert.deepEqual(docxAfter.paragraphs, ['new value']);
  assert.equal(docxAfter.sha256, docxEdit.after_sha256);

  await context.createXlsx('ws_doc', 'edit.xlsx', [{
    name: 'Data',
    cells: [{ cell: 'A1', value: 'old' }],
  }]);
  const xlsxBefore = await context.inspectXlsx('ws_doc', 'edit.xlsx') as { sha256: string };
  const xlsxEdit = await context.setXlsxCells(
    'ws_doc', 'edit.xlsx', xlsxBefore.sha256, 'Data', [{ cell: 'A1', value: 'new' }],
  ) as { after_sha256: string; updated_cells: number };
  assert.equal(xlsxEdit.updated_cells, 1);
  const xlsxAfter = await context.inspectXlsx('ws_doc', 'edit.xlsx') as {
    sha256: string;
    sheets: Array<{ cells: Array<{ cell: string; value: unknown }> }>;
  };
  assert.equal(xlsxAfter.sha256, xlsxEdit.after_sha256);
  assert.deepEqual(xlsxAfter.sheets[0]!.cells[0], { cell: 'A1', value: 'new' });

  await context.createPdf('ws_doc', 'edit.pdf', ['base text']);
  const pdfBytes = await readFile(join(root, 'edit.pdf'));
  const pdfEdit = await context.overlayPdfText('ws_doc', 'edit.pdf', sha(pdfBytes), {
    page: 1,
    text: 'overlay',
    x: 72,
    y: 700,
  }) as { after_sha256: string; page_count: number };
  assert.equal(pdfEdit.page_count, 1);
  const pdfAfter = await readFile(join(root, 'edit.pdf'));
  assert.equal(sha(pdfAfter), pdfEdit.after_sha256);
});

test('DOCX and XLSX inspect redact secret-shaped cell and paragraph content', async (t) => {
  const { context } = await fixture(t);

  await context.createDocx('ws_doc', 'secret.docx', [
    'API_KEY=supersecret123456789',
    'ordinary text',
  ]);
  const docx = await context.inspectDocx('ws_doc', 'secret.docx') as {
    paragraphs: string[];
    redacted: boolean;
  };
  assert.equal(docx.redacted, true);
  assert.match(docx.paragraphs[0]!, /<REDACTED>/);
  assert.equal(docx.paragraphs[0]!.includes('supersecret123456789'), false);

  await context.createXlsx('ws_doc', 'secret.xlsx', [{
    name: 'Data',
    cells: [
      { cell: 'A1', value: 'TOKEN=topsecret123456789' },
      { cell: 'A2', value: 'safe' },
    ],
  }]);
  const xlsx = await context.inspectXlsx('ws_doc', 'secret.xlsx') as {
    sheets: Array<{ cells: Array<{ value: unknown }> }>;
    redacted: boolean;
  };
  assert.equal(xlsx.redacted, true);
  assert.equal(String(xlsx.sheets[0]!.cells[0]!.value).includes('topsecret123456789'), false);
  assert.match(String(xlsx.sheets[0]!.cells[0]!.value), /<REDACTED>/);
});
