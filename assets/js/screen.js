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
      this.sourceBuffer.remove(buffered.start(0), Math.max(buffered.start(0), this.video.currentTime - 2));
    } catch {
      /* nothing removable yet */
    }
  }

  /**
   * Live streams drift: if the element falls behind the newest fragment it
   * plays further and further into the past. Skip forward when that happens.
   */
  #trim() {
    const buffered = this.video.buffered;
    if (buffered.length === 0) return;

    const end = buffered.end(buffered.length - 1);
    if (end - this.video.currentTime > 6) {
      this.video.currentTime = end - 0.5;
      this.#evict();
    }
  }

  stop() {
    this.stopped = true;
    this.queue = [];

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
