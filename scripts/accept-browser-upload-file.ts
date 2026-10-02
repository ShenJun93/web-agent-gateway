import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPrivateBrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Real browser upload acceptance requires Windows');
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-upload-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const uploadPath = join(workspace, 'upload.txt');
  await writeFile(uploadPath, 'upload-payload-123\n', 'utf8');

  let receivedResolve!: (value: Buffer) => void;
  let receivedReject!: (error: Error) => void;
  const received = new Promise<Buffer>((resolve, reject) => {
    receivedResolve = resolve;
    receivedReject = reject;
  });

  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end([
        '<!doctype html><html><body>',
        '<form method="post" enctype="multipart/form-data" action="/upload">',
        '<input type="file" name="demo" aria-label="Upload demo file">',
        '<button type="submit" aria-label="Submit upload">Submit</button>',
        '</form></body></html>',
      ].join(''));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/upload') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        request.destroy(new Error('upload acceptance body exceeded bound'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once('error', (error) => receivedReject(error));
    request.once('end', () => {
      const body = Buffer.concat(chunks);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      receivedResolve(body);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('acceptance server address unavailable');

  const runtime = createPrivateBrowserMcpContext({
    owner: {
      ownerId: 'browser_upload_acceptance',
      sessionId: 'browser_upload_acceptance',
      adapterId: 'private.stdio.v1',
    },
    edgeExecutablePath: EDGE,
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
    resolveUploadFiles: async (workspaceId, paths) => {
      assert.equal(workspaceId, 'ws_upload_acceptance');
      assert.deepEqual(paths, ['upload.txt']);
      return [{
        relative_path: 'upload.txt',
        absolute_path: uploadPath,
        size_bytes: 19,
      }];
    },
  });

  try {
    const opened = await runtime.open('upload-acceptance', 'WAG_HEADLESS');
    const sessionId = opened.browserSessionId;
    await runtime.exec(sessionId, 'upload.accept.navigate', {
      type: 'navigate',
      url: `http://127.0.0.1:${address.port}/`,
    });

    let snapshot = await runtime.snapshot(sessionId);
    const fileNode = snapshot.nodes.find((node) => node.name === 'Upload demo file');
    const submitNode = snapshot.nodes.find((node) => node.name === 'Submit upload');
    assert.ok(fileNode?.ref, 'semantic file input ref must exist');
    assert.ok(submitNode?.ref, 'semantic submit ref must exist');

    const first = await runtime.uploadFile(
      sessionId,
      'upload.accept.file.once',
      'ws_upload_acceptance',
      fileNode.ref,
      ['upload.txt'],
    );
    assert.equal(first.state, 'SUCCEEDED');

    const replay = await runtime.uploadFile(
      sessionId,
      'upload.accept.file.once',
      'ws_upload_acceptance',
      fileNode.ref,
      ['upload.txt'],
    );
    assert.equal(replay.effectId, first.effectId);
    assert.equal(replay.state, 'SUCCEEDED');

    snapshot = await runtime.snapshot(sessionId);
    const currentSubmit = snapshot.nodes.find((node) => node.name === 'Submit upload');
    assert.ok(currentSubmit?.ref, 'submit ref must be refreshed after upload snapshot');
    await runtime.exec(sessionId, 'upload.accept.submit', {
      type: 'click',
      ref: currentSubmit.ref,
    });

    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('multipart upload was not received')), 10_000);
      timer.unref?.();
    });
    const body = await Promise.race([received, timeout]);
    const text = body.toString('utf8');
    assert.match(text, /filename="upload\.txt"/);
    assert.match(text, /upload-payload-123/);

    console.log(JSON.stringify({
      state: 'PASS',
      browser_session_id: sessionId,
      upload_effect_id: first.effectId,
      replay_same_effect: replay.effectId === first.effectId,
      semantic_file_ref: true,
      native_file_chooser_used: false,
      multipart_filename_verified: true,
      multipart_content_verified: true,
    }));
  } finally {
    await runtime.closeAll().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

await main();
