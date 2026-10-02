import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { sanitizeLocalMachineEnvironment } from './environment-policy.js';

const DEFAULT_ANALYSIS_SECONDS = 120;
const MAX_ANALYSIS_SECONDS = 600;
const PROBE_TIMEOUT_MS = 20_000;
const ANALYSIS_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

export interface MediaCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export type MediaCommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<MediaCommandResult>;

export interface MediaVideoStream {
  index: number;
  codec: string;
  width: number;
  height: number;
  pixel_format?: string;
  frame_rate?: number;
  duration_seconds?: number;
  bit_rate?: number;
}

export interface MediaAudioStream {
  index: number;
  codec: string;
  sample_rate_hz?: number;
  channels?: number;
  channel_layout?: string;
  duration_seconds?: number;
  bit_rate?: number;
}

export interface MediaLoudness {
  integrated_lufs: number;
  true_peak_dbfs?: number;
  loudness_range_lu?: number;
  threshold_lufs?: number;
}

export interface MediaBlackSegment {
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
}

export interface MediaInspection {
  path: string;
  filename: string;
  size_bytes: number;
  format_name: string;
  duration_seconds: number;
  bit_rate?: number;
  video_streams: MediaVideoStream[];
  audio_streams: MediaAudioStream[];
  analysis: {
    requested_seconds: number;
    analyzed_seconds: number;
    complete: boolean;
    loudness: MediaLoudness | null;
    black_frames: {
      segments: MediaBlackSegment[];
      total_black_seconds: number;
      ratio: number;
      max_segment_seconds: number;
    } | null;
  };
}

export interface MediaVerification {
  state: 'PASS' | 'FAIL';
  profile: 'web-demo';
  inspection: MediaInspection;
  checks: Array<{
    name: string;
    status: 'PASS' | 'FAIL' | 'WARN';
    detail: string;
  }>;
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function frameRate(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const [left, right] = value.split('/');
  const numerator = Number(left);
  const denominator = right === undefined ? 1 : Number(right);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

async function runFixed(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<MediaCommandResult> {
  return await new Promise<MediaCommandResult>((resolveRun, reject) => {
    const child = spawn(executable, [...args], {
      env: sanitizeLocalMachineEnvironment(process.env),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;

    const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      const part = chunk.subarray(0, remaining);
      bytes += part.length;
      if (kind === 'stdout') stdout += part.toString('utf8');
      else stderr += part.toString('utf8');
      if (part.length !== chunk.length) {
        truncated = true;
        child.kill('SIGKILL');
      }
    };

    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (error) => reject(new Error(`Media helper unavailable: ${error.message}`)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.once('close', (code) => {
      clearTimeout(timer);
      resolveRun({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
        truncated,
      });
    });
  });
}

function parseProbe(stdout: string): {
  format?: Record<string, unknown>;
  streams?: Array<Record<string, unknown>>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Media probe returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Media probe returned invalid JSON');
  const value = parsed as { format?: unknown; streams?: unknown };
  return {
    ...(value.format && typeof value.format === 'object'
      ? { format: value.format as Record<string, unknown> }
      : {}),
    ...(Array.isArray(value.streams)
      ? { streams: value.streams.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') }
      : {}),
  };
}

function extractLastJsonObject(text: string): Record<string, unknown> | undefined {
  const matches = text.match(/\{[\s\S]*?\}/g);
  if (!matches) return undefined;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(matches[index]!) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // Continue to the previous JSON-shaped block.
    }
  }
  return undefined;
}

function parseLoudness(stderr: string): MediaLoudness | null {
  const value = extractLastJsonObject(stderr);
  if (!value) return null;
  const integrated = finiteNumber(value.input_i);
  if (integrated === undefined) return null;
  return {
    integrated_lufs: integrated,
    ...(finiteNumber(value.input_tp) === undefined ? {} : { true_peak_dbfs: finiteNumber(value.input_tp)! }),
    ...(finiteNumber(value.input_lra) === undefined ? {} : { loudness_range_lu: finiteNumber(value.input_lra)! }),
    ...(finiteNumber(value.input_thresh) === undefined ? {} : { threshold_lufs: finiteNumber(value.input_thresh)! }),
  };
}

function parseBlackFrames(stderr: string, analyzedSeconds: number): NonNullable<MediaInspection['analysis']['black_frames']> {
  const segments: MediaBlackSegment[] = [];
  const expression = /black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(stderr)) !== null) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    const duration = Number(match[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(duration)) continue;
    segments.push({
      start_seconds: start,
      end_seconds: end,
      duration_seconds: duration,
    });
  }
  const total = segments.reduce((sum, item) => sum + item.duration_seconds, 0);
  const maxSegment = segments.reduce((max, item) => Math.max(max, item.duration_seconds), 0);
  return {
    segments,
    total_black_seconds: total,
    ratio: analyzedSeconds > 0 ? Math.min(total / analyzedSeconds, 1) : 0,
    max_segment_seconds: maxSegment,
  };
}

export async function inspectMediaFile(input: {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  analysisSeconds?: number;
}, options: {
  run?: MediaCommandRunner;
  platform?: NodeJS.Platform;
} = {}): Promise<MediaInspection> {
  const requestedSeconds = input.analysisSeconds ?? DEFAULT_ANALYSIS_SECONDS;
  if (!Number.isFinite(requestedSeconds) || requestedSeconds < 1 || requestedSeconds > MAX_ANALYSIS_SECONDS) {
    throw new Error(`Media analysis seconds must be in [1,${MAX_ANALYSIS_SECONDS}]`);
  }

  const platform = options.platform ?? process.platform;
  const runner = options.run ?? runFixed;
  const probeExecutable = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const ffmpegExecutable = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const nullSink = platform === 'win32' ? 'NUL' : '/dev/null';

  const probe = await runner(probeExecutable, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    input.absolutePath,
  ], PROBE_TIMEOUT_MS);
  if (probe.timedOut) throw new Error('Media probe timed out');
  if (probe.truncated) throw new Error('Media probe output exceeded bound');
  if (probe.exitCode !== 0) throw new Error('Media probe failed');

  const parsed = parseProbe(probe.stdout);
  const format = parsed.format ?? {};
  const streams = parsed.streams ?? [];
  const videoStreams: MediaVideoStream[] = [];
  const audioStreams: MediaAudioStream[] = [];

  for (const stream of streams) {
    const index = Number(stream.index);
    if (!Number.isInteger(index) || index < 0) continue;
    if (stream.codec_type === 'video') {
      videoStreams.push({
        index,
        codec: typeof stream.codec_name === 'string' ? stream.codec_name : '',
        width: Number.isInteger(Number(stream.width)) ? Number(stream.width) : 0,
        height: Number.isInteger(Number(stream.height)) ? Number(stream.height) : 0,
        ...(typeof stream.pix_fmt === 'string' ? { pixel_format: stream.pix_fmt } : {}),
        ...(frameRate(stream.avg_frame_rate ?? stream.r_frame_rate) === undefined
          ? {}
          : { frame_rate: frameRate(stream.avg_frame_rate ?? stream.r_frame_rate)! }),
        ...(positiveNumber(stream.duration) === undefined ? {} : { duration_seconds: positiveNumber(stream.duration)! }),
        ...(positiveNumber(stream.bit_rate) === undefined ? {} : { bit_rate: positiveNumber(stream.bit_rate)! }),
      });
    } else if (stream.codec_type === 'audio') {
      audioStreams.push({
        index,
        codec: typeof stream.codec_name === 'string' ? stream.codec_name : '',
        ...(positiveNumber(stream.sample_rate) === undefined ? {} : { sample_rate_hz: positiveNumber(stream.sample_rate)! }),
        ...(positiveNumber(stream.channels) === undefined ? {} : { channels: positiveNumber(stream.channels)! }),
        ...(typeof stream.channel_layout === 'string' ? { channel_layout: stream.channel_layout } : {}),
        ...(positiveNumber(stream.duration) === undefined ? {} : { duration_seconds: positiveNumber(stream.duration)! }),
        ...(positiveNumber(stream.bit_rate) === undefined ? {} : { bit_rate: positiveNumber(stream.bit_rate)! }),
      });
    }
  }

  const streamDurations = [...videoStreams, ...audioStreams]
    .map((stream) => stream.duration_seconds)
    .filter((value): value is number => value !== undefined);
  const duration = positiveNumber(format.duration)
    ?? (streamDurations.length === 0 ? 0 : Math.max(...streamDurations));
  const analyzedSeconds = duration > 0 ? Math.min(duration, requestedSeconds) : requestedSeconds;
  const complete = duration > 0 && requestedSeconds >= duration - 0.05;

  let loudness: MediaLoudness | null = null;
  if (audioStreams.length > 0) {
    const loudnessRun = await runner(ffmpegExecutable, [
      '-hide_banner', '-nostdin', '-v', 'info',
      '-i', input.absolutePath,
      '-t', String(analyzedSeconds),
      '-map', '0:a:0',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null',
      nullSink,
    ], ANALYSIS_TIMEOUT_MS);
    if (loudnessRun.timedOut) throw new Error('Media loudness analysis timed out');
    if (loudnessRun.truncated) throw new Error('Media loudness output exceeded bound');
    if (loudnessRun.exitCode !== 0) throw new Error('Media loudness analysis failed');
    loudness = parseLoudness(loudnessRun.stderr);
  }

  let blackFrames: MediaInspection['analysis']['black_frames'] = null;
  if (videoStreams.length > 0) {
    const blackRun = await runner(ffmpegExecutable, [
      '-hide_banner', '-nostdin', '-v', 'info',
      '-i', input.absolutePath,
      '-t', String(analyzedSeconds),
      '-map', '0:v:0',
      '-vf', 'blackdetect=d=0.5:pic_th=0.98:pix_th=0.10',
      '-an',
      '-f', 'null',
      nullSink,
    ], ANALYSIS_TIMEOUT_MS);
    if (blackRun.timedOut) throw new Error('Media black-frame analysis timed out');
    if (blackRun.truncated) throw new Error('Media black-frame output exceeded bound');
    if (blackRun.exitCode !== 0) throw new Error('Media black-frame analysis failed');
    blackFrames = parseBlackFrames(blackRun.stderr, analyzedSeconds);
  }

  return {
    path: input.relativePath,
    filename: basename(input.relativePath),
    size_bytes: input.sizeBytes,
    format_name: typeof format.format_name === 'string' ? format.format_name : '',
    duration_seconds: duration,
    ...(positiveNumber(format.bit_rate) === undefined ? {} : { bit_rate: positiveNumber(format.bit_rate)! }),
    video_streams: videoStreams,
    audio_streams: audioStreams,
    analysis: {
      requested_seconds: requestedSeconds,
      analyzed_seconds: analyzedSeconds,
      complete,
      loudness,
      black_frames: blackFrames,
    },
  };
}

export function verifyMediaInspection(inspection: MediaInspection): MediaVerification {
  const checks: MediaVerification['checks'] = [];
  const check = (
    name: string,
    status: 'PASS' | 'FAIL' | 'WARN',
    detail: string,
  ) => checks.push({ name, status, detail });

  check(
    'duration',
    inspection.duration_seconds >= 1 ? 'PASS' : 'FAIL',
    `duration=${inspection.duration_seconds.toFixed(3)}s`,
  );

  const video = inspection.video_streams[0];
  check('video_stream', video ? 'PASS' : 'FAIL', video ? `codec=${video.codec}` : 'missing video stream');
  if (video) {
    check('video_codec', video.codec ? 'PASS' : 'FAIL', video.codec || 'missing codec');
    check(
      'resolution',
      video.width > 0 && video.height > 0 ? 'PASS' : 'FAIL',
      `${video.width}x${video.height}`,
    );
  }

  const audio = inspection.audio_streams[0];
  check('audio_stream', audio ? 'PASS' : 'FAIL', audio ? `codec=${audio.codec}` : 'missing audio stream');
  if (audio) {
    check('audio_codec', audio.codec ? 'PASS' : 'FAIL', audio.codec || 'missing codec');
  }

  const loudness = inspection.analysis.loudness;
  if (!audio) {
    check('loudness', 'FAIL', 'cannot measure loudness without audio');
  } else if (!loudness) {
    check('loudness', 'FAIL', 'loudness analysis unavailable');
  } else {
    check(
      'loudness',
      loudness.integrated_lufs >= -50 ? 'PASS' : 'FAIL',
      `integrated=${loudness.integrated_lufs.toFixed(2)} LUFS`,
    );
  }

  const black = inspection.analysis.black_frames;
  if (!video) {
    check('black_frames', 'FAIL', 'cannot analyze black frames without video');
  } else if (!black) {
    check('black_frames', 'FAIL', 'black-frame analysis unavailable');
  } else if (black.ratio > 0.95) {
    check('black_frames', 'FAIL', `black_ratio=${black.ratio.toFixed(3)}`);
  } else if (black.ratio > 0.25 || black.max_segment_seconds > 5) {
    check(
      'black_frames',
      'WARN',
      `black_ratio=${black.ratio.toFixed(3)}, max_segment=${black.max_segment_seconds.toFixed(3)}s`,
    );
  } else {
    check(
      'black_frames',
      'PASS',
      `black_ratio=${black.ratio.toFixed(3)}, max_segment=${black.max_segment_seconds.toFixed(3)}s`,
    );
  }

  check(
    'analysis_coverage',
    inspection.analysis.complete ? 'PASS' : 'WARN',
    inspection.analysis.complete
      ? 'full media analyzed'
      : `analyzed first ${inspection.analysis.analyzed_seconds.toFixed(3)}s of ${inspection.duration_seconds.toFixed(3)}s`,
  );

  return {
    state: checks.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS',
    profile: 'web-demo',
    inspection,
    checks,
  };
}
