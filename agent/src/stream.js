/**
 * Built-in screen streaming.
 *
 * Captures the desktop with ffmpeg, encodes H.264 into a *fragmented* MP4, and
 * emits the byte stream in chunks. Fragmented MP4 is what makes this work in a
 * browser with no plugins: the page feeds the chunks straight into a
 * MediaSource, which is supported everywhere.
 *
 * This is the low-setup option — ffmpeg and nothing else. It is a second or so
 * behind real time, which is fine for watching a game but not for twitch
 * aiming; moonlight-web-stream (with Sunshine) remains the low-latency path and
 * the agent detects that too.
 */
import { spawn, spawnSync } from 'node:child_process';

/**
 * Where a WebM stream stops being header and starts being video: the first
 * Cluster element. Everything before it (EBML header, Segment, Info, Tracks)
 * is what a late-joining decoder needs.
 */
const WEBM_CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

function findWebmInitLength(buffer) {
  const index = buffer.indexOf(WEBM_CLUSTER);
  return index > 0 ? index : -1;
}

/** Where an fMP4 stream stops being header and starts being video. */
function findMp4InitLength(buffer) {
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);

    // The first `moof` begins the media; everything before it is the header
    // (`ftyp` + `moov`) that a late-joining viewer needs first.
    if (type === 'moof') return offset;

    // 1 means the real size is a 64-bit value after the type; 0 means "to end
    // of stream", which cannot be true of a header box.
    if (size === 1) {
      if (offset + 16 > buffer.length) return -1;
      const large = Number(buffer.readBigUInt64BE(offset + 8));
      if (!Number.isSafeInteger(large) || large <= 0) return -1;
      offset += large;
      continue;
    }
    if (size < 8) return -1;
    offset += size;
  }

  return -1;
}

const findInitLength = (buffer, container = 'mp4') =>
  container === 'webm' ? findWebmInitLength(buffer) : findMp4InitLength(buffer);

/**
 * H.264-in-fMP4 is the default: every current browser plays it and it encodes
 * cheaply. Some builds ship without H.264 (Chromium without proprietary
 * codecs, Firefox on some Linux distributions), so VP8-in-WebM is offered as
 * an alternative and the page picks whichever it can actually decode.
 */
export const CODECS = {
  h264: { container: 'mp4', mime: 'video/mp4; codecs="avc1.640029"' },
  vp8: { container: 'webm', mime: 'video/webm; codecs="vp8"' },
};

export function detectFfmpeg(explicit) {
  const candidates = [explicit, process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 8000 });
      if (result.status === 0) {
        return { path: candidate, version: (result.stdout || '').split('\n')[0] };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Platform-specific desktop capture input arguments. */
function captureInput({ fps, display }) {
  if (process.platform === 'win32') {
    // gdigrab works on every Windows build; ddagrab is faster but needs a
    // recent ffmpeg and a D3D11 device, which cannot be assumed.
    return ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1', '-i', display || 'desktop'];
  }
  if (process.platform === 'darwin') {
    return ['-f', 'avfoundation', '-capture_cursor', '1', '-framerate', String(fps), '-i', display || '1:none'];
  }
  return ['-f', 'x11grab', '-framerate', String(fps), '-i', display || process.env.DISPLAY || ':0.0'];
}

export class ScreenStream {
  /**
   * @param {object} options
   * @param {string} options.ffmpegPath
   * @param {(chunk: Buffer, isInit: boolean) => void} options.onChunk
   * @param {(error: Error|null) => void} options.onExit
   */
  constructor({ ffmpegPath, fps = 30, bitrate = '6M', height = 1080, display = null, input = null, codec = 'h264', onChunk, onExit }) {
    this.ffmpegPath = ffmpegPath;
    this.codec = CODECS[codec] ? codec : 'h264';
    this.container = CODECS[this.codec].container;
    this.mime = CODECS[this.codec].mime;
    this.fps = Math.min(Math.max(Number(fps) || 30, 5), 60);
    this.bitrate = String(bitrate || '6M');
    this.height = Math.min(Math.max(Number(height) || 1080, 240), 2160);
    this.display = display;
    this.input = input;
    this.onChunk = onChunk;
    this.onExit = onExit;

    this.process = null;
    this.init = null;
    this.pending = [];
    this.pendingLength = 0;
    this.stderr = '';
  }

  get running() {
    return Boolean(this.process);
  }

  args() {
    const source = this.input
      ? // Test/advanced hook: any ffmpeg input spec, e.g. "lavfi:testsrc=size=1280x720:rate=30"
        this.input.startsWith('lavfi:')
        ? ['-f', 'lavfi', '-i', this.input.slice(6)]
        : ['-i', this.input]
      : captureInput({ fps: this.fps, display: this.display });

    const common = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...source,
      '-an',
      '-vf',
      `scale=-2:min(${this.height}\\,ih)`,
      '-b:v',
      this.bitrate,
      '-maxrate',
      this.bitrate,
      '-bufsize',
      this.bitrate,
      // A keyframe every second so a viewer joining late starts quickly.
      '-g',
      String(this.fps),
    ];

    if (this.container === 'webm') {
      return [
        ...common,
        '-c:v',
        'libvpx',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'webm',
        // `live` stops the muxer seeking back to patch in a duration, which
        // it cannot do on a pipe.
        '-live',
        '1',
        '-cluster_time_limit',
        '250',
        'pipe:1',
      ];
    }

    return [
      ...common,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-keyint_min',
      String(this.fps),
      '-sc_threshold',
      '0',
      '-f',
      'mp4',
      // empty_moov + frag_keyframe is what makes the output streamable;
      // frag_duration keeps fragments short so latency stays low.
      // (The flag is `default_base_moof` — `default_base_is_moof` is the name
      // of the tfhd bit it sets, and ffmpeg rejects that spelling.)
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
      '-frag_duration',
      '200000',
      'pipe:1',
    ];
  }

  start() {
    if (this.process) return { ok: true, alreadyRunning: true };

    this.init = null;
    this.pending = [];
    this.pendingLength = 0;
    this.stderr = '';

    this.process = spawn(this.ffmpegPath, this.args(), { stdio: ['ignore', 'pipe', 'pipe'] });

    this.process.stdout.on('data', (chunk) => this.#consume(chunk));

    this.process.stderr.on('data', (chunk) => {
      // Keep only the tail; ffmpeg is chatty and the last lines are the useful
      // ones when capture fails.
      this.stderr = `${this.stderr}${chunk}`.slice(-2000);
    });

    this.process.on('error', (error) => {
      this.process = null;
      this.onExit?.(error);
    });

    this.process.on('close', (code) => {
      const failed = code !== 0 && code !== null;
      this.process = null;
      this.onExit?.(failed ? new Error(`ffmpeg exited ${code}: ${this.stderr.trim().split('\n').pop() || 'no output'}`) : null);
    });

    return { ok: true };
  }

  /**
   * Split the raw ffmpeg output into the init segment and everything after.
   * ffmpeg does not align its writes to box boundaries, so the header is
   * buffered until the first `moof` shows where it ends.
   */
  #consume(chunk) {
    if (this.init) {
      this.onChunk?.(chunk, false);
      return;
    }

    this.pending.push(chunk);
    this.pendingLength += chunk.length;

    const buffer = Buffer.concat(this.pending, this.pendingLength);
    const initLength = findInitLength(buffer, this.container);

    if (initLength <= 0) {
      // Header still incomplete — unless something is very wrong.
      if (this.pendingLength > 4 * 1024 * 1024) {
        this.stop();
        this.onExit?.(new Error(`ffmpeg produced no ${this.container} header`));
      }
      return;
    }

    this.init = buffer.subarray(0, initLength);
    this.pending = [];
    this.pendingLength = 0;

    this.onChunk?.(this.init, true);
    const rest = buffer.subarray(initLength);
    if (rest.length) this.onChunk?.(rest, false);
  }

  stop() {
    if (!this.process) return;
    const child = this.process;
    this.process = null;
    try {
      child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
      // ffmpeg occasionally ignores the first signal while flushing.
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2000).unref?.();
    } catch {
      /* already gone */
    }
  }
}

export const internals = { findInitLength, findMp4InitLength, findWebmInitLength };
