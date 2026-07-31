/**
 * Roger beeps and haptics. One shared AudioContext, created lazily inside a user
 * gesture (iOS will not start one otherwise) and resumed on demand.
 */

import { debugLog } from '../state';

let ctx: AudioContext | null = null;

/** Get (or lazily create) the shared AudioContext. Call from a user gesture first. */
export function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    debugLog('audio', 'no AudioContext');
    return null;
  }
  ctx = new Ctor();
  return ctx;
}

/** Nudge a suspended context awake. Safe to call repeatedly. */
export async function resumeAudio(): Promise<void> {
  const c = audioContext();
  if (c && c.state === 'suspended') {
    try {
      await c.resume();
    } catch (err) {
      debugLog('audio-resume', err);
    }
  }
}

/**
 * A short sine beep with a 8 ms attack/release ramp - a hard gate on a sine wave
 * clicks, and the click is louder than the beep on phone speakers.
 */
function beep(freq: number, ms: number, gain = 0.12): void {
  const c = audioContext();
  if (!c) return;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0, t0);
  amp.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  amp.gain.setValueAtTime(gain, t0 + ms / 1000 - 0.008);
  amp.gain.linearRampToValueAtTime(0, t0 + ms / 1000);
  osc.connect(amp).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.01);
}

/** Press tone: 1180 Hz, 90 ms. */
export function toneStart(): void {
  beep(1180, 90);
}

/** Release tone: 760 Hz, 110 ms. */
export function toneEnd(): void {
  beep(760, 110);
}

/** Someone else started transmitting. Quieter, so it does not mask their first word. */
export function toneRemote(): void {
  beep(980, 60, 0.06);
}

/** Something went wrong. */
export function toneError(): void {
  beep(320, 160, 0.1);
}

/** Vibrate, where the browser allows it. iOS Safari does not, and that is fine. */
export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
