/**
 * Push-To-Talk (PTT) microphone management and VU meter visualization.
 * Handles microphone permissions, track enabling/disabling, roger tones,
 * state notifications, and WebAudio canvas volume meter rendering.
 */

import { audioContext, resumeAudio, toneEnd, toneStart, vibrate } from './tones';
import { debugLog, notify, state } from '../state';

export let micTrack: MediaStreamTrack | null = null;
let micStream: MediaStream | null = null;

let analyser: AnalyserNode | null = null;
let meterCanvas: HTMLCanvasElement | null = null;
let animFrameId: number | null = null;

/**
 * Request microphone access and retrieve the local audio track.
 * Updates state.micState and returns the track or null on failure.
 */
export async function openMic(): Promise<MediaStreamTrack | null> {
  if (micTrack && micTrack.readyState === 'live') {
    state.micState = 'open';
    notify();
    return micTrack;
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    state.micState = 'unavailable';
    debugLog('mic', 'getUserMedia not supported');
    notify();
    return null;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    micTrack = micStream.getAudioTracks()[0] ?? null;
    if (micTrack) {
      // Keep disabled by default until PTT button is held
      micTrack.enabled = state.transmitting;
      state.micState = 'open';
      setupAnalyser(micStream);
    } else {
      state.micState = 'unavailable';
    }
  } catch (err) {
    debugLog('mic-error', err);
    if (err instanceof DOMException) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        state.micState = 'denied';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        state.micState = 'unavailable';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        state.micState = 'busy';
      } else {
        state.micState = 'unavailable';
      }
    } else {
      state.micState = 'unavailable';
    }
  }

  notify();
  return micTrack;
}

/**
 * Set the transmitting state (PTT held vs released).
 * Plays start/stop tones and enables/disables local microphone track.
 */
export async function setTransmitting(tx: boolean): Promise<void> {
  if (state.transmitting === tx) return;

  void resumeAudio();

  if (tx && (!micTrack || micTrack.readyState !== 'live')) {
    await openMic();
  }

  if (!tx) {
    state.pttLatched = false;
  }

  state.transmitting = tx;

  if (micTrack) {
    micTrack.enabled = tx;
  }

  if (tx) {
    toneStart();
    vibrate(35);
  } else {
    toneEnd();
    vibrate(20);
  }

  notify();
}

/** Set up WebAudio analyser node for input level visualization */
function setupAnalyser(stream: MediaStream): void {
  const ctx = audioContext();
  if (!ctx) return;

  try {
    const source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
  } catch (err) {
    debugLog('analyser-setup', err);
  }
}

/**
 * Attach the volume VU meter animation to a target HTML canvas element.
 */
export function attachMeter(canvas: HTMLCanvasElement): void {
  meterCanvas = canvas;
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
  }

  const draw = () => {
    if (meterCanvas !== canvas || !document.body.contains(canvas)) {
      return;
    }

    renderMeter(canvas);
    animFrameId = requestAnimationFrame(draw);
  };

  animFrameId = requestAnimationFrame(draw);
}

function renderMeter(canvas: HTMLCanvasElement): void {
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;

  const w = (canvas.width = canvas.clientWidth || 300);
  const h = (canvas.height = canvas.clientHeight || 40);

  ctx2d.clearRect(0, 0, w, h);

  let level = 0;
  if (analyser && state.transmitting) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i] ?? 0;
    }
    level = Math.min(1, sum / (data.length * 255) * 2.5);
  }

  // Draw background track bar
  ctx2d.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx2d.fillRect(0, h / 2 - 4, w, 8);

  // Draw active volume meter bar
  const meterWidth = Math.max(0, w * level);
  const gradient = ctx2d.createLinearGradient(0, 0, w, 0);
  gradient.addColorStop(0, '#22c55e');
  gradient.addColorStop(0.7, '#eab308');
  gradient.addColorStop(1, '#ef4444');

  ctx2d.fillStyle = state.transmitting ? gradient : 'rgba(255, 255, 255, 0.1)';
  ctx2d.fillRect(0, h / 2 - 4, state.transmitting ? meterWidth : 0, 8);
}
