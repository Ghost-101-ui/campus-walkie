/**
 * Voice-note fallback.
 *
 * When a peer's RTCPeerConnection is `failed` (symmetric NAT, carrier CGNAT, no
 * TURN) but the relay is alive, live PTT to that peer is impossible. Rather than
 * pretending, we record what was said and push it through the relay as a sealed,
 * chunked payload, and label it `relayed` in the UI.
 *
 * Codec: `audio/webm;codecs=opus` everywhere except Safari, which only gives us
 * `audio/mp4` (AAC). Both are decoded by every target browser via <audio>.
 */

import { debugLog } from '../state';

/** Hard cap on a clip. Long enough for a sentence, short enough to arrive. */
export const MAX_CLIP_MS = 20_000;
const BITS_PER_SECOND = 24_000;

const CANDIDATE_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

/** The best MediaRecorder mime type this browser supports, or null if none. */
export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

export interface Clip {
  bytes: Uint8Array;
  mime: string;
  durationMs: number;
}

/**
 * Records from `stream` until {@link VoiceNoteRecorder.stop} or MAX_CLIP_MS.
 * The recorder is created per clip: reusing one across clips leaks state on Safari.
 */
export class VoiceNoteRecorder {
  private rec: MediaRecorder | null = null;
  private parts: Blob[] = [];
  private started = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settle: ((clip: Clip | null) => void) | null = null;
  readonly mime: string | null;

  constructor(private readonly stream: MediaStream) {
    this.mime = pickMimeType();
  }

  get recording(): boolean {
    return this.rec !== null;
  }

  /** Start recording. Returns false when MediaRecorder is unavailable. */
  start(): boolean {
    if (this.rec || !this.mime) return false;
    try {
      this.rec = new MediaRecorder(this.stream, {
        mimeType: this.mime,
        audioBitsPerSecond: BITS_PER_SECOND,
      });
    } catch (err) {
      debugLog('recorder', err);
      this.rec = null;
      return false;
    }
    this.parts = [];
    this.started = Date.now();
    this.rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.parts.push(ev.data);
    };
    this.rec.onstop = () => void this.finish();
    this.rec.start(250); // timeslice: gives us data even if the tab is killed mid-clip
    this.timer = setTimeout(() => void this.stop(), MAX_CLIP_MS);
    return true;
  }

  /** Stop and resolve with the clip, or null if nothing usable was captured. */
  stop(): Promise<Clip | null> {
    if (!this.rec) return Promise.resolve(null);
    const p = new Promise<Clip | null>((resolve) => {
      this.settle = resolve;
    });
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.rec.stop();
    } catch (err) {
      debugLog('recorder-stop', err);
      this.settle?.(null);
    }
    return p;
  }

  private async finish(): Promise<void> {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    const mime = this.mime ?? 'audio/webm';
    const blob = new Blob(this.parts, { type: mime });
    this.parts = [];
    const settle = this.settle;
    this.settle = null;
    if (blob.size === 0) {
      settle?.(null);
      return;
    }
    settle?.({
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mime,
      durationMs: Date.now() - this.started,
    });
  }
}

/**
 * A tiny amplitude waveform for a recorded clip, as `count` values in 0-1.
 * Decoded with the shared AudioContext; if decoding fails (Safari + mp4 quirks) we
 * return a flat line rather than blocking the message from rendering.
 */
export async function waveform(
  bytes: Uint8Array,
  ctx: AudioContext | null,
  count = 48,
): Promise<number[]> {
  if (!ctx) return new Array<number>(count).fill(0.35);
  try {
    // decodeAudioData detaches the buffer, so hand it a copy.
    const copy = bytes.slice().buffer;
    const audio = await ctx.decodeAudioData(copy);
    const data = audio.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / count));
    const out: number[] = [];
    let max = 0.0001;
    for (let i = 0; i < count; i++) {
      let peak = 0;
      for (let j = 0; j < per; j++) peak = Math.max(peak, Math.abs(data[i * per + j] ?? 0));
      out.push(peak);
      max = Math.max(max, peak);
    }
    return out.map((v) => Math.min(1, v / max));
  } catch (err) {
    debugLog('waveform', err);
    return new Array<number>(count).fill(0.35);
  }
}
