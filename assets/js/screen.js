/**
 * Plays the agent's screen stream.
 *
 * The agent encodes the desktop as a fragmented MP4 and pushes it down the
 * relay socket as binary frames; each frame carries a one-byte marker saying
 * whether it is the fMP4 header or a media fragment. MediaSource Extensions
 * turn that byte stream back into a playing <video> with no plugin and no
 * second connection.
 */

const KIND_INIT = 1;
const KIND_MEDIA = 2;

/**
 * What the agent can encode, best first. H.264 is preferred — it encodes
 * cheaply on the streaming PC and every mainstream browser plays it — but
 * builds without proprietary codecs (Chromium as shipped by some distros,
 * Firefox on some Linux setups) only have VP8, so that is offered too.
 */
const CODECS = [
  { codec: 'h264', mimes: ['video/mp4; codecs="avc1.640029"', 'video/mp4; codecs="avc1.4d402a"', 'video/mp4; codecs="avc1.42E01E"'] },
  { codec: 'vp8', mimes: ['video/webm; codecs="vp8"'] },
];

/**
 * Live-edge tuning. `DRIFT_S` is roughly two frames at 60 fps — below that,
 * correcting would cost more than the delay does.
 */
const DRIFT_S = 0.15;
const JUMP_AHEAD_S = 0.6;
const CATCHUP_RATE = 1.06;

/** The best codec this browser can actually decode, or null. */
export function pickCodec() {
  if (typeof MediaSource === 'undefined') return null;
  for (const entry of CODECS) {
    const mime = entry.mimes.find((candidate) => MediaSource.isTypeSupported(candidate));
    if (mime) return { codec: entry.codec, mime };
  }
  return null;
}

export const isSupported = () => pickCodec() !== null;

export class ScreenPlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {(status: {state: string, detail?: string}) => void} [onStatus]
   */
  constructor(video, onStatus, mime = null) {
    this.video = video;
    this.onStatus = onStatus || (() => {});
    this.mime = mime;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.gotInit = false;
    this.stopped = false;
    this.objectUrl = null;

    /** How far behind the newest decoded frame we currently are, in ms. */
    this.behindMs = 0;
    this.statsTimer = null;
  }

  start() {
    const chosen = this.mime || pickCodec()?.mime;
    if (!chosen) {
      this.onStatus({ state: 'error', detail: 'This browser cannot play the stream — no supported video codec.' });
      return false;
    }
    this.mime = chosen;

    this.stopped = false;
    this.gotInit = false;
    this.queue = [];

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    this.video.muted = true;
    this.video.playsInline = true;
    // Never let the element buffer ahead of the live edge on its own.
    this.video.preload = 'none';

    // Report the measured delay so the page can show it rather than claiming
    // a latency figure nobody has verified.
    clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => {
      if (this.stopped) return;
      this.#trim();
      this.onStatus({ state: 'stats', behindMs: this.behindMs });
    }, 1000);

    this.mediaSource.addEventListener(
      'sourceopen',
      () => {
        try {
          this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mime);
          // Fragments arrive in order and carry their own timing.
          this.sourceBuffer.mode = 'sequence';
          this.sourceBuffer.addEventListener('updateend', () => this.#drain());
          this.sourceBuffer.addEventListener('error', () =>
            this.onStatus({ state: 'error', detail: 'The browser rejected the video data.' }),
          );
          this.onStatus({ state: 'waiting' });
          this.#drain();
        } catch (error) {
          this.onStatus({ state: 'error', detail: error.message });
        }
      },
      { once: true },
    );

    return true;
  }

  /** Feed one binary frame straight from the relay socket. */
  push(arrayBuffer) {
    if (this.stopped || !arrayBuffer) return;

    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 2) return;

    const kind = bytes[0];
    const payload = bytes.subarray(1);

    if (kind === KIND_INIT) {
      // A fresh header means the agent restarted its encoder; drop anything
      // queued from the previous run rather than splicing two streams.
      if (this.gotInit) this.queue = [];
      this.gotInit = true;
    } else if (kind !== KIND_MEDIA || !this.gotInit) {
      // Fragments before the header cannot be decoded.
      return;
    }

    this.queue.push(payload);
    this.#drain();
  }

  #drain() {
    if (this.stopped || !this.sourceBuffer || this.sourceBuffer.updating || this.queue.length === 0) return;

    const chunk = this.queue.shift();
    try {
      this.sourceBuffer.appendBuffer(chunk);
    } catch (error) {
      if (error.name === 'QuotaExceededError') {
        this.#evict();
        this.queue.unshift(chunk);
        return;
      }
      this.onStatus({ state: 'error', detail: error.message });
      return;
    }

    if (this.video.paused) {
      this.video.play().then(
        () => this.onStatus({ state: 'playing' }),
        () => this.onStatus({ state: 'blocked', detail: 'Press play to start the stream.' }),
      );
    }

    this.#trim();
  }

  /** Drop already-played video so the buffer cannot grow without bound. */
  #evict() {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    const buffered = this.sourceBuffer.buffered;
    if (buffered.length === 0) return;
    try {
      // Keep half a second of history — enough for the decoder, not enough to
      // let the element sit in the past.
      const cutoff = Math.max(buffered.start(0), this.video.currentTime - 0.5);
      if (cutoff > buffered.start(0)) this.sourceBuffer.remove(buffered.start(0), cutoff);
    } catch {
      /* nothing removable yet */
    }
  }

  /**
   * Hold the live edge.
   *
   * A `<video>` fed by MediaSource plays whatever is at `currentTime` and has
   * no notion of "live" — every stall, every dropped frame and every buffered
   * fragment pushes it further into the past, permanently. So the delay behind
   * the newest decoded frame is measured continuously and corrected two ways:
   * a small drift is absorbed by playing slightly fast (invisible), and a real
   * gap is closed by seeking. Without this the picture is correct but
   * progressively later, which is exactly what "laggy" looks like.
   */
  #trim() {
    const buffered = this.video.buffered;
    if (buffered.length === 0) return;

    const end = buffered.end(buffered.length - 1);
    const behind = end - this.video.currentTime;
    this.behindMs = Math.max(0, Math.round(behind * 1000));

    if (behind > JUMP_AHEAD_S) {
      // Too far gone to catch up by speeding — jump to the newest frame.
      this.video.currentTime = Math.max(buffered.start(0), end - 0.05);
      this.video.playbackRate = 1;
      this.#evict();
      return;
    }

    if (behind > DRIFT_S) {
      // 6% is under the threshold where audio would sound wrong and video
      // looks fast, so the catch-up is not visible.
      if (this.video.playbackRate !== CATCHUP_RATE) this.video.playbackRate = CATCHUP_RATE;
    } else if (this.video.playbackRate !== 1) {
      this.video.playbackRate = 1;
    }

    this.#evict();
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    clearInterval(this.statsTimer);
    this.statsTimer = null;

    try {
      if (this.mediaSource?.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      /* already closed */
    }

    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    this.sourceBuffer = null;
    this.mediaSource = null;
    this.gotInit = false;
  }
}
