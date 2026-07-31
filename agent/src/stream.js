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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The agent's own directory, so an installed encoder stays self-contained. */
const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_FFMPEG = path.join(
  AGENT_DIR,
  'node_modules',
  'ffmpeg-static',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
);

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

function ffmpegWorks(candidate) {
  try {
    const result = spawnSync(candidate, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) return null;
    return { path: candidate, version: (result.stdout || '').split('\n')[0] };
  } catch {
    return null;
  }
}

/**
 * Find an encoder. The bundled copy is preferred over whatever is on PATH
 * because we know exactly which build it is.
 */
export function detectFfmpeg(explicit) {
  const candidates = [explicit, process.env.FFMPEG_PATH, BUNDLED_FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const candidate of candidates) {
    // A path we constructed has to exist before it is worth executing.
    if (candidate === BUNDLED_FFMPEG && !fs.existsSync(candidate)) continue;
    const found = ffmpegWorks(candidate);
    if (found) return found;
  }
  return null;
}

/**
 * Fetch an encoder if there is not one already.
 *
 * `ffmpeg-static` publishes the right static build for each platform and is an
 * optional dependency, so a normal `npm install` usually has it already. When
 * it does not — a failed or skipped optional install — it is fetched here with
 * npm rather than by downloading and unpacking archives by hand: npm is
 * certainly present (the user ran it to get this far) and the package handles
 * platform and architecture detection itself.
 *
 * Everything lands inside the agent's own `node_modules`. Nothing is installed
 * system-wide, no PATH is modified and no elevation is asked for.
 */
export async function ensureFfmpeg({ explicit = null, allowInstall = true, timeoutMs = 180_000, log = console.log } = {}) {
  const existing = detectFfmpeg(explicit);
  if (existing) return { ...existing, installed: false };
  if (!allowInstall) return null;

  log('[agent] no ffmpeg found — fetching one (about 30 MB, one time)…');

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const ok = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(npm, ['install', 'ffmpeg-static', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: AGENT_DIR,
        stdio: ['ignore', 'inherit', 'inherit'],
        // npm is a shell script on Windows and cannot be spawned directly.
        shell: process.platform === 'win32',
      });
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(false);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });

  if (!ok) {
    log('[agent] could not fetch ffmpeg automatically — install it yourself and restart, or pass --ffmpeg <path>.');
    return null;
  }

  const found = detectFfmpeg(explicit);
  if (found) log('[agent] ffmpeg ready.');
  return found ? { ...found, installed: true } : null;
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
