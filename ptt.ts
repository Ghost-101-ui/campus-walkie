/**
 * Microphone ownership and push-to-talk gating.
 *
 * The mic is opened once, inside the join gesture, and then held open with
 * `track.enabled = false`. Pressing PTT flips one boolean - no getUserMedia, no
 * renegotiation, no codec warm-up - which is the difference between "instant" and
 * "half a second late". The cost is that the mic really is open, so the UI says so
 * permanently.
 */

import { debugLog, notify, state } from '../state';
import { audioContext, resumeAudio, toneEnd, toneStart, vibrate } from './tones';

/** A pocket-pressed button cannot broadcast a lecture. */
export const MAX_TRANSMIT_MS = 60_000;

const CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

let stream: MediaStream | null = null;
let track: MediaStreamTrack | null = null;
let autoReleaseTimer: ReturnType<typeof setTimeout> | null = null;
let onAutoRelease: (() => void) | null = null;

/** The muted-but-live mic track, or null before {@link openMic}. */
export function micTrack(): MediaStreamTrack | null {
  return track;
}

/**
 * Open the microphone. Must be called from a user gesture.
 * Sets `state.micState` to 'open' | 'denied' | 'busy' | 'unavailable'.
 */
export async function openMic(): Promise<MediaStreamTrack | null> {
  if (track) return track;
  if (!navigator.mediaDevices?.getUserMedia) {
    state.micState = 'unavailable';
    notify();
    debugLog('mic', 'no getUserMedia (needs https or localhost)');
    return null;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
  } catch (err) {
    const name = err instanceof DOMException ? err.name : 'Error';
    state.micState =
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'denied'
        : name === 'NotReadableError' || name === 'AbortError'
          ? 'busy'
          : 'unavailable';
    notify();
    debugLog('mic-error', `${name}`);
    return null;
  }
  const [first] = stream.getAudioTracks();
  if (!first) {
    state.micState = 'unavailable';
    notify();
    return null;
  }
  track = first;
  track.enabled = false; // open, muted: this is what makes PTT instant
  track.onended = () => {
    state.micState = 'unavailable';
    notify();
    debugLog('mic', 'track ended');
  };
  state.micState = 'open';
  notify();
  return track;
}

/** Register the callback fired when a transmission is cut off at 60 s. */
export function setAutoReleaseHandler(fn: () => void): void {
  onAutoRelease = fn;
}

/**
 * Open or close the gate. Returns the new transmitting value, which may be false
 * if the mic is not available.
 */
export function setTransmitting(on: boolean): boolean {
  if (!track || state.micState !== 'open') return false;
  if (on === state.transmitting) return on;

  track.enabled = on;
  state.transmitting = on;
  void resumeAudio();

  if (on) {
    toneStart();
    vibrate(25);
    startMeter();
    autoReleaseTimer = setTimeout(() => {
      debugLog('ptt', 'auto-release at 60s');
      onAutoRelease?.();
    }, MAX_TRANSMIT_MS);
  } else {
    toneEnd();
    vibrate([20, 40, 20]);
    if (autoReleaseTimer !== null) clearTimeout(autoReleaseTimer);
    autoReleaseTimer = null;
  }
  notify();
  return on;
}

/** Close the mic completely. The indicator goes to 'off'. */
export function closeMic(): void {
  if (autoReleaseTimer !== null) clearTimeout(autoReleaseTimer);
  autoReleaseTimer = null;
  stopMeter();
  if (track) track.enabled = false;
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  track = null;
  analyser = null;
  source = null;
  state.micState = 'off';
  state.transmitting = false;
  notify();
}

/* ------------------------------------------------------------- level meter */

let canvas: HTMLCanvasElement | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let remoteAnalyser: AnalyserNode | null = null;
let raf = 0;
let lastFrame = 0;

/** Point the meter at a canvas. Called once when the channel screen mounts. */
export function attachMeter(el: HTMLCanvasElement): void {
  canvas = el;
}

function localAnalyser(): AnalyserNode | null {
  if (analyser) return analyser;
  const ctx = audioContext();
  if (!ctx || !stream) return null;
  try {
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser); // analyser is a sink: never connected to destination
  } catch (err) {
    debugLog('analyser', err);
    return null;
  }
  return analyser;
}

/**
 * Analyse a remote stream too, so the strip shows the level of whoever is talking.
 * Safari has long-standing bugs feeding remote WebRTC streams into Web Audio; when
 * the data comes back silent we fall back to a synthetic pulse (see draw()).
 */
export function setRemoteMeterStream(remote: MediaStream | null): void {
  remoteAnalyser = null;
  const ctx = audioContext();
  if (!ctx || !remote) return;
  try {
    const src = ctx.createMediaStreamSource(remote);
    const a = ctx.createAnalyser();
    a.fftSize = 256;
    a.smoothingTimeConstant = 0.6;
    src.connect(a);
    remoteAnalyser = a;
  } catch (err) {
    debugLog('remote-analyser', err);
  }
}

/** Start the meter loop. Idempotent. */
export function startMeter(): void {
  if (raf !== 0) return;
  const step = (t: number) => {
    // Battery: cap at 30 fps and stop entirely when nobody is talking.
    if (t - lastFrame >= 33) {
      lastFrame = t;
      if (!draw()) {
        raf = 0;
        return;
      }
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

/** Stop the meter loop and clear the canvas. */
export function stopMeter(): void {
  if (raf !== 0) cancelAnimationFrame(raf);
  raf = 0;
  clear();
}

function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}

function clear(): void {
  const c = canvas;
  const ctx2d = c?.getContext('2d');
  if (!c || !ctx2d) return;
  ctx2d.clearRect(0, 0, c.width, c.height);
}

/** Returns false when there is nothing to draw, which stops the loop. */
function draw(): boolean {
  const c = canvas;
  const ctx2d = c?.getContext('2d');
  if (!c || !ctx2d) return false;

  const active = state.transmitting || state.talker !== '';
  if (!active) {
    clear();
    return false;
  }

  const node = state.transmitting ? localAnalyser() : remoteAnalyser;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(c.clientWidth * dpr);
  const h = Math.floor(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }

  let level = 0;
  if (node) {
    const bins = new Uint8Array(node.frequencyBinCount);
    node.getByteFrequencyData(bins);
    let sum = 0;
    for (const b of bins) sum += b;
    level = Math.min(1, sum / bins.length / 128);
  }
  // Fallback pulse: better an honest "someone is talking" than a dead bar.
  if (level < 0.02) level = 0.25 + 0.15 * Math.sin(performance.now() / 140);

  ctx2d.clearRect(0, 0, w, h);
  const accent = state.transmitting ? css('--danger', '#ef4444') : css('--accent', '#22c55e');
  const bars = 32;
  const gap = Math.max(1, Math.floor(dpr));
  const barW = (w - gap * (bars - 1)) / bars;
  ctx2d.fillStyle = accent;
  for (let i = 0; i < bars; i++) {
    const centreBias = 1 - Math.abs(i / (bars - 1) - 0.5) * 1.2;
    const bh = Math.max(dpr, level * h * centreBias);
    ctx2d.fillRect(i * (barW + gap), (h - bh) / 2, barW, bh);
  }
  return true;
}
