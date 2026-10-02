import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectMediaFile,
  verifyMediaInspection,
  type MediaCommandRunner,
  type MediaInspection,
} from '../src/local-machine-media.js';

test('media inspect parses bounded ffprobe, loudness and black-frame evidence', async () => {
  const calls: Array<{ executable: string; args: readonly string[]; timeoutMs: number }> = [];
  const run: MediaCommandRunner = async (executable, args, timeoutMs) => {
    calls.push({ executable, args, timeoutMs });
    if (executable === 'ffprobe.exe') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: { format_name: 'mov,mp4', duration: '10.0', bit_rate: '2000000' },
          streams: [
            {
              index: 0,
              codec_type: 'video',
              codec_name: 'h264',
              width: 1920,
              height: 1080,
              pix_fmt: 'yuv420p',
              avg_frame_rate: '30/1',
              duration: '10.0',
              bit_rate: '1800000',
            },
            {
              index: 1,
              codec_type: 'audio',
              codec_name: 'aac',
              sample_rate: '48000',
              channels: 2,
              channel_layout: 'stereo',
              duration: '10.0',
              bit_rate: '128000',
            },
          ],
        }),
        stderr: '',
        timedOut: false,
        truncated: false,
      };
    }
    if (args.some((value) => value.includes('loudnorm='))) {
      return {
        exitCode: 0,
        stdout: '',
        stderr: [
          '[Parsed_loudnorm] summary',
          '{',
          '  "input_i" : "-18.50",',
          '  "input_tp" : "-2.10",',
          '  "input_lra" : "4.20",',
          '  "input_thresh" : "-29.00"',
          '}',
        ].join('\n'),
        timedOut: false,
        truncated: false,
      };
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '[blackdetect] black_start:0 black_end:1 black_duration:1\n',
      timedOut: false,
      truncated: false,
    };
  };

  const inspection = await inspectMediaFile({
    relativePath: 'demo.mp4',
    absolutePath: 'E:\\accepted\\demo.mp4',
    sizeBytes: 123456,
    analysisSeconds: 20,
  }, { run, platform: 'win32' });

  assert.equal(inspection.duration_seconds, 10);
  assert.equal(inspection.analysis.analyzed_seconds, 10);
  assert.equal(inspection.analysis.complete, true);
  assert.equal(inspection.video_streams[0]?.codec, 'h264');
  assert.equal(inspection.video_streams[0]?.width, 1920);
  assert.equal(inspection.audio_streams[0]?.codec, 'aac');
  assert.equal(inspection.analysis.loudness?.integrated_lufs, -18.5);
  assert.equal(inspection.analysis.black_frames?.segments.length, 1);
  assert.equal(inspection.analysis.black_frames?.ratio, 0.1);
  assert.deepEqual(calls.map((call) => call.executable), ['ffprobe.exe', 'ffmpeg.exe', 'ffmpeg.exe']);
  assert.equal(calls.every((call) => call.args.includes('E:\\accepted\\demo.mp4')), true);

  const verification = verifyMediaInspection(inspection);
  assert.equal(verification.state, 'PASS');
  assert.equal(verification.checks.some((item) => item.status === 'FAIL'), false);
});

test('verify.media fails a demo with no audio stream', () => {
  const inspection: MediaInspection = {
    path: 'silent.mp4',
    filename: 'silent.mp4',
    size_bytes: 100,
    format_name: 'mov,mp4',
    duration_seconds: 8,
    video_streams: [{ index: 0, codec: 'h264', width: 1280, height: 720 }],
    audio_streams: [],
    analysis: {
      requested_seconds: 120,
      analyzed_seconds: 8,
      complete: true,
      loudness: null,
      black_frames: {
        segments: [],
        total_black_seconds: 0,
        ratio: 0,
        max_segment_seconds: 0,
      },
    },
  };

  const verification = verifyMediaInspection(inspection);
  assert.equal(verification.state, 'FAIL');
  assert.equal(
    verification.checks.find((item) => item.name === 'audio_stream')?.status,
    'FAIL',
  );
  assert.equal(
    verification.checks.find((item) => item.name === 'loudness')?.status,
    'FAIL',
  );
});

test('verify.media rejects effectively silent audio and near-total black video', () => {
  const inspection: MediaInspection = {
    path: 'broken.mp4',
    filename: 'broken.mp4',
    size_bytes: 100,
    format_name: 'mov,mp4',
    duration_seconds: 10,
    video_streams: [{ index: 0, codec: 'h264', width: 1920, height: 1080 }],
    audio_streams: [{ index: 1, codec: 'aac', channels: 2 }],
    analysis: {
      requested_seconds: 10,
      analyzed_seconds: 10,
      complete: true,
      loudness: { integrated_lufs: -60 },
      black_frames: {
        segments: [{ start_seconds: 0, end_seconds: 9.8, duration_seconds: 9.8 }],
        total_black_seconds: 9.8,
        ratio: 0.98,
        max_segment_seconds: 9.8,
      },
    },
  };

  const verification = verifyMediaInspection(inspection);
  assert.equal(verification.state, 'FAIL');
  assert.equal(verification.checks.find((item) => item.name === 'loudness')?.status, 'FAIL');
  assert.equal(verification.checks.find((item) => item.name === 'black_frames')?.status, 'FAIL');
});
