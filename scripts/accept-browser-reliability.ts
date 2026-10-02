import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPrivateBrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MEDIA = 'E:\\WAG-Acceptance\\p0-upload-media-fixtures\\good.mp4';

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Real browser reliability acceptance requires Windows');
  await readFile(MEDIA);

  const root = await mkdtemp(join(tmpdir(), 'wag-browser-reliability-'));
  const server = createServer((request, response) => {
    if (request.url === '/good.mp4') {
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
      });
      createReadStream(MEDIA).pipe(response);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end([
      '<!doctype html><html><head><title>WAG Reliability Fixture</title></head><body>',
      '<div role="status" id="status">Processing</div>',
      '<video aria-label="Demo player" src="/good.mp4" autoplay muted playsinline></video>',
      '<script>setTimeout(()=>{document.getElementById("status").textContent="Checks complete";},500);</script>',
      '</body></html>',
    ].join(''));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('acceptance server address unavailable');

  const runtime = createPrivateBrowserMcpContext({
    owner: {
      ownerId: 'browser_reliability_acceptance',
      sessionId: 'browser_reliability_acceptance',
      adapterId: 'private.stdio.v1',
    },
    edgeExecutablePath: EDGE,
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
  });

  try {
    const opened = await runtime.open('reliability-acceptance', 'WAG_HEADLESS');
    const sessionId = opened.browserSessionId;
    const url = `http://127.0.0.1:${address.port}/fixture`;

    await runtime.exec(sessionId, 'reliability.navigate.once', { type: 'navigate', url });

    const waited = await runtime.waitFor(sessionId, [
      { kind: 'title', operator: 'equals', value: 'WAG Reliability Fixture' },
      { kind: 'node', name: 'Checks complete' },
    ], 'all', 10_000, 100);
    assert.equal(waited.matched, true);
    assert.ok(waited.attempts >= 1);
    assert.ok(waited.elapsed_ms < 10_000);

    const asserted = await runtime.assertSemantic(sessionId, [
      { kind: 'url', operator: 'contains', value: '/fixture' },
      { kind: 'node', name: 'Checks complete' },
      { kind: 'node', name: 'Processing failed', present: false },
    ]);
    assert.equal(asserted.matched, true);

    let snapshot = await runtime.snapshot(sessionId);
    let mediaNode = snapshot.nodes.find((node) => node.name === 'Demo player');
    if (!mediaNode) {
      await runtime.waitFor(sessionId, [
        { kind: 'node', name: 'Demo player' },
      ], 'all', 5_000, 100);
      snapshot = await runtime.snapshot(sessionId);
      mediaNode = snapshot.nodes.find((node) => node.name === 'Demo player');
    }
    assert.ok(mediaNode?.ref, 'semantic media ref must exist');

    const media = await runtime.inspectMedia(sessionId, mediaNode.ref);
    assert.equal(media.tag, 'video');
    assert.equal(media.error, null);
    assert.equal(media.muted, true);
    assert.ok((media.duration_seconds ?? 0) > 2);
    assert.ok((media.video_width ?? 0) >= 640);
    assert.ok((media.video_height ?? 0) >= 360);
    assert.ok(['PRESENT', 'UNKNOWN'].includes(media.audio_evidence));

    console.log(JSON.stringify({
      state: 'PASS',
      browser_session_id: sessionId,
      wait_attempts: waited.attempts,
      wait_elapsed_ms: waited.elapsed_ms,
      semantic_assert: asserted.matched,
      media: {
        tag: media.tag,
        paused: media.paused,
        ended: media.ended,
        muted: media.muted,
        volume: media.volume,
        duration_seconds: media.duration_seconds,
        current_time_seconds: media.current_time_seconds,
        ready_state: media.ready_state,
        network_state: media.network_state,
        error: media.error,
        audio_evidence: media.audio_evidence,
        audio_decoded_bytes: media.audio_decoded_bytes,
        audio_track_count: media.audio_track_count,
        video_width: media.video_width,
        video_height: media.video_height,
      },
      arbitrary_selector_or_js_exposed: false,
    }));
  } finally {
    await runtime.closeAll().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

await main();
