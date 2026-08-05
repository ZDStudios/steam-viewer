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
  const candidates = [explicit, process.env.FFMPEG_PATH, LOCAL_BIN, BUNDLED_FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const candidate of candidates) {
    // A path we constructed has to exist before it is worth executing.
    if ((candidate === BUNDLED_FFMPEG || candidate === LOCAL_BIN) && !fs.existsSync(candidate)) continue;
    const found = ffmpegWorks(candidate);
    if (found) return found;
  }
  return null;
}

/**
 * Where a self-installed encoder lives. Kept beside the agent so removing the
 * folder removes everything it ever downloaded.
 */
const LOCAL_DIR = path.join(AGENT_DIR, '.ffmpeg');
const LOCAL_BIN = path.join(LOCAL_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

/**
 * Static builds, by platform. BtbN publishes a `latest` tag that always points
 * at a current build, so these URLs do not need updating.
 */
function downloadPlan() {
  if (process.platform === 'win32') {
    return {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
      archive: 'ffmpeg.zip',
      kind: 'zip',
    };
  }
  if (process.platform === 'darwin') {
    return { url: 'https://evermeet.cx/ffmpeg/getrelease/zip', archive: 'ffmpeg.zip', kind: 'zip' };
  }
  const arch = process.arch === 'arm64' ? 'linuxarm64' : 'linux64';
  return {
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${arch}-gpl.tar.xz`,
    archive: 'ffmpeg.tar.xz',
    kind: 'tar.xz',
  };
}

function extractCommand(kind, archivePath, targetDir) {
  if (kind === 'zip') {
    // Expand-Archive ships with Windows PowerShell; macOS has unzip.
    return process.platform === 'win32'
      ? {
          command: 'powershell',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${targetDir}" -Force`,
          ],
        }
      : { command: 'unzip', args: ['-o', '-q', archivePath, '-d', targetDir] };
  }
  return { command: 'tar', args: ['-xJf', archivePath, '-C', targetDir] };
}

/** Find the ffmpeg executable anywhere inside an extracted build. */
function findBinary(dir, depth = 0) {
  if (depth > 4) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const wanted = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === wanted) return full;
    if (entry.isDirectory()) {
      const found = findBinary(full, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function run(command, args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    let child;
    try {
      // No `shell: true` here — arguments carry filesystem paths, and letting a
      // shell re-parse them is both fragile and a quoting hazard.
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      resolve(false);
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-800);
    });
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
      resolve(code === 0 || { failed: stderr.trim() });
    });
  });
}

/**
 * Fetch an encoder if there is not one already.
 *
 * The download happens *in this process* rather than by shelling out to npm.
 * That matters on machines where antivirus or a corporate proxy inspects
 * HTTPS: this process already has whatever certificate configuration got it
 * talking to the relay (`--use-system-ca`, `--ca`, …), whereas a child npm —
 * and the postinstall script of a package like ffmpeg-static — starts fresh,
 * fails to verify the intercepted certificate, and reports success anyway
 * because the dependency is optional. That is the "up to date, but no binary"
 * case this replaces.
 *
 * Everything lands in `agent/.ffmpeg`. Nothing is installed system-wide, no
 * PATH is modified, and nothing needs administrator rights.
 */
export async function ensureFfmpeg({ explicit = null, allowInstall = true, log = console.log } = {}) {
  const existing = detectFfmpeg(explicit);
  if (existing) return { ...existing, installed: false };
  if (!allowInstall) return null;

  const plan = downloadPlan();
  log('[agent] no ffmpeg found — downloading a static build (~30 MB, one time)…');

  try {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
  } catch (error) {
    log(`[agent] could not create ${LOCAL_DIR}: ${error.message}`);
    return null;
  }

  const archivePath = path.join(LOCAL_DIR, plan.archive);

  try {
    const response = await fetch(plan.url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`server responded ${response.status}`);
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    log(`[agent] download failed: ${error.message}`);
    log('[agent] install ffmpeg yourself and restart, or pass --ffmpeg <path>.');
    log('[agent]   Windows:  winget install Gyan.FFmpeg');
    log('[agent]   macOS:    brew install ffmpeg');
    log('[agent]   Linux:    sudo apt install ffmpeg');
    return null;
  }

  const { command, args } = extractCommand(plan.kind, archivePath, LOCAL_DIR);
  const extracted = await run(command, args);
  if (extracted !== true) {
    log(`[agent] could not unpack the download${extracted?.failed ? `: ${extracted.failed}` : ''}.`);
    return null;
  }

  const binary = findBinary(LOCAL_DIR);
  if (!binary) {
    log('[agent] the download did not contain an ffmpeg executable.');
    return null;
  }

  // Flatten to a predictable location so later runs skip all of this.
  try {
    if (path.resolve(binary) !== path.resolve(LOCAL_BIN)) fs.copyFileSync(binary, LOCAL_BIN);
    if (process.platform !== 'win32') fs.chmodSync(LOCAL_BIN, 0o755);
    fs.rmSync(archivePath, { force: true });
  } catch (error) {
    log(`[agent] could not place the binary: ${error.message}`);
    return null;
  }

  const found = ffmpegWorks(LOCAL_BIN);
  if (found) log(`[agent] ffmpeg ready (${LOCAL_BIN}).`);
  else log('[agent] the downloaded ffmpeg would not run.');
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
  constructor({ ffmpegPath, fps = 60, bitrate = '12M', height = 1080, display = null, input = null, codec = 'h264', onChunk, onExit }) {
    this.ffmpegPath = ffmpegPath;
    this.codec = CODECS[codec] ? codec : 'h264';
    this.container = CODECS[this.codec].container;
    this.mime = CODECS[this.codec].mime;
    // 30 fps is the floor: below that the stream stops feeling like a game.
    this.fps = Math.min(Math.max(Number(fps) || 60, 30), 120);
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
      // Latency starts at the input. By default ffmpeg spends up to five
      // seconds probing a source before it emits anything, and buffers frames
      // on the way in; on a screen grab there is nothing to learn from probing
      // and nothing to gain from buffering.
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-probesize',
      '32',
      '-analyzeduration',
      '0',
      ...source,
      // Push every packet down the pipe the moment it exists instead of
      // letting the muxer accumulate a comfortable write.
      '-flush_packets',
      '1',
      '-an',
      '-vf',
      `scale=-2:min(${this.height}\\,ih)`,
      '-b:v',
      this.bitrate,
      '-maxrate',
      this.bitrate,
      // A one-frame VBV buffer stops the encoder holding frames back to smooth
      // its bitrate — smoothing is exactly the delay we are trying to remove.
      '-bufsize',
      this.bitrate,
      // A keyframe every two seconds. Longer than the old one-second interval
      // because keyframes are large and a bitrate spike is itself latency;
      // late joiners still start within two seconds.
      '-g',
      String(this.fps * 2),
    ];

    if (this.container === 'webm') {
      return [
        ...common,
        '-c:v',
        'libvpx',
        '-deadline',
        'realtime',
        // 8 is the fastest setting; anything lower spends CPU on quality we
        // trade away for time.
        '-cpu-used',
        '8',
        // Without this libvpx keeps frames in flight to look ahead.
        '-lag-in-frames',
        '0',
        '-error-resilient',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'webm',
        // `live` stops the muxer seeking back to patch in a duration, which
        // it cannot do on a pipe.
        '-live',
        '1',
        // One cluster per frame-ish, so the browser gets data continuously
        // instead of in quarter-second lumps.
        '-cluster_time_limit',
        '40',
        '-cluster_size_limit',
        '256000',
        'pipe:1',
      ];
    }

    return [
      ...common,
      '-c:v',
      'libx264',
      // ultrafast + zerolatency is the combination that actually removes the
      // encoder's own delay: no B-frames, no lookahead, no frame reordering.
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      // Baseline-ish settings decode faster in the browser than High does, and
      // the picture is a desktop, not a film.
      '-profile:v',
      'main',
      '-pix_fmt',
      'yuv420p',
      // No B-frames and a single reference: nothing is held back waiting for a
      // future frame, which is where most of an encoder's latency lives.
      // (`-tune zerolatency` already implies these; they are spelled out so a
      // future tune change cannot quietly reintroduce the delay.)
      '-bf',
      '0',
      '-refs',
      '1',
      '-sc_threshold',
      '0',
      '-keyint_min',
      String(this.fps),
      '-f',
      'mp4',
      // empty_moov + frag_keyframe is what makes the output streamable.
      // `frag_every_frame` is the low-latency part: without it the muxer waits
      // for a whole fragment to complete before writing anything, so the floor
      // on latency is the fragment length no matter how fast the encoder is.
      '-movflags',
      '+frag_keyframe+frag_every_frame+empty_moov+default_base_moof+omit_tfhd_offset',
      '-frag_duration',
      '16000',
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
