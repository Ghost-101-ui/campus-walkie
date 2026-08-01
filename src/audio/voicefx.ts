/**
 * Voice FX Engine — Real-time microphone processing via Web Audio API.
 *
 * Inserts a processing graph between the raw mic stream and the track
 * sent over WebRTC. Peers hear the processed/filtered audio.
 *
 * Pipeline:
 *   [MediaStream] → [Source] → [Filter Chain] → [GainNode] → [Destination]
 *                                                                  ↓
 *                                                         processed MediaStreamTrack
 *
 * Pitch shifting uses a granular delay-line technique (two overlapping
 * delay buffers modulated by a sawtooth LFO) — no external libraries.
 */

import { audioContext } from './tones';
import type { VoiceFilter } from '../state';

interface FxChain {
  nodes: AudioNode[];
  destination: MediaStreamAudioDestinationNode;
  outputGain: GainNode;
}

let activeChain: FxChain | null = null;
let processedStream: MediaStream | null = null;

// ----------------------------------------------------------------- helpers

/** Hard-clip WaveShaper curve for distortion/overdrive */
function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 256;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

/** Radio bandpass distortion curve (more aggressive) */
function makeRadioCurve(): Float32Array<ArrayBuffer> {
  const n = 256;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(3 * x);
  }
  return curve;
}

// ---------------------------------------------------------- pitch shifting

/**
 * Granular delay-line pitch shifter using two delay buffers with a
 * crossfading sawtooth LFO. Works natively in Web Audio with no workers.
 *
 * @param ctx  AudioContext
 * @param src  Source node to pitch-shift
 * @param semitones  Amount to shift (positive = up, negative = down)
 * @returns OutputNode that emits the pitch-shifted audio
 */
function createPitchShifter(
  ctx: AudioContext,
  src: AudioNode,
  semitones: number
): AudioNode {
  const rate = Math.pow(2, semitones / 12);
  const bufferTime = 0.1; // 100ms grain buffer

  // Two delay nodes acting as grains
  const delayA = ctx.createDelay(bufferTime);
  const delayB = ctx.createDelay(bufferTime);
  const gainA = ctx.createGain();
  const gainB = ctx.createGain();

  // LFO drives the two delay times 180° apart (sawtooth)
  const lfoFreq = (1 - rate) / bufferTime;
  const clampedFreq = Math.max(0.5, Math.min(20, Math.abs(lfoFreq)));

  const lfoA = ctx.createOscillator();
  const lfoB = ctx.createOscillator();
  lfoA.type = 'sawtooth';
  lfoB.type = 'sawtooth';
  lfoA.frequency.value = clampedFreq;
  lfoB.frequency.value = clampedFreq;

  const lfoGainA = ctx.createGain();
  const lfoGainB = ctx.createGain();
  lfoGainA.gain.value = bufferTime / 2;
  lfoGainB.gain.value = bufferTime / 2;

  // Cross-fade envelope: triangle wave from LFO
  const envA = ctx.createWaveShaper();
  const envB = ctx.createWaveShaper();
  const envCurve = new Float32Array(new ArrayBuffer(256 * 4));
  for (let i = 0; i < 256; i++) {
    const v = (i / 255) * 2 - 1; // -1 to 1
    envCurve[i] = 1 - Math.abs(v);
  }
  envA.curve = envCurve;
  envB.curve = envCurve;

  // Offset B by half period for 180° phase
  const constantOffset = ctx.createConstantSource();
  constantOffset.offset.value = bufferTime / 2;
  constantOffset.start();

  const merger = ctx.createGain();
  merger.gain.value = 1.0;

  // Wire LFOs → delay times
  lfoA.connect(lfoGainA).connect(delayA.delayTime);
  lfoB.connect(lfoGainB).connect(delayB.delayTime);

  // Wire LFOs → crossfade gains via envelope shapers
  lfoA.connect(envA).connect(gainA.gain);
  lfoB.connect(envB).connect(gainB.gain);

  // Audio path: src → delay → scaled gain → output
  src.connect(delayA);
  src.connect(delayB);
  delayA.connect(gainA);
  delayB.connect(gainB);
  gainA.connect(merger);
  gainB.connect(merger);

  lfoA.start();
  lfoB.start();

  return merger;
}

// --------------------------------------------------------------- presets

function buildNone(_ctx: AudioContext, src: AudioNode): AudioNode[] {
  // Bypass — straight through, no processing
  void src; // used in setVoiceFilter for the 'none' case
  return [];
}

function buildAnime(ctx: AudioContext, src: AudioNode): { nodes: AudioNode[]; out: AudioNode } {
  const nodes: AudioNode[] = [];

  // 1. Remove chest/body resonance below 180Hz
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 180;
  hp.Q.value = 0.7;
  nodes.push(hp);

  // 2. Formant peak boost in anime-vocal range (2.8kHz ~ "kawaii" bright midrange)
  const formant = ctx.createBiquadFilter();
  formant.type = 'peaking';
  formant.frequency.value = 2800;
  formant.Q.value = 1.4;
  formant.gain.value = 7;
  nodes.push(formant);

  // 3. High-shelf sparkle (6kHz+) to add airiness
  const shelf = ctx.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 6000;
  shelf.gain.value = 5;
  nodes.push(shelf);

  // 4. Pitch shift up +5 semitones
  src.connect(hp);
  hp.connect(formant);
  formant.connect(shelf);
  const pitched = createPitchShifter(ctx, shelf, 5);
  nodes.push(pitched as AudioNode);

  return { nodes, out: pitched };
}

function buildRadio(ctx: AudioContext, src: AudioNode): { nodes: AudioNode[]; out: AudioNode } {
  const nodes: AudioNode[] = [];

  // 1. Band-pass to simulate radio frequency response (300Hz–3.5kHz)
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = 1200;
  bandpass.Q.value = 0.6;
  nodes.push(bandpass);

  // 2. Distortion (radio crunch)
  const distort = ctx.createWaveShaper();
  distort.curve = makeRadioCurve();
  distort.oversample = '2x';
  nodes.push(distort);

  // 3. Notch to kill mid-hum
  const notch = ctx.createBiquadFilter();
  notch.type = 'notch';
  notch.frequency.value = 800;
  notch.Q.value = 3;
  nodes.push(notch);

  // 4. Compressor for broadcast feel
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.knee.value = 6;
  comp.ratio.value = 6;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  nodes.push(comp);

  src.connect(bandpass);
  bandpass.connect(distort);
  distort.connect(notch);
  notch.connect(comp);

  return { nodes, out: comp };
}

function buildRobot(ctx: AudioContext, src: AudioNode): { nodes: AudioNode[]; out: AudioNode } {
  const nodes: AudioNode[] = [];

  // Ring modulator: multiply mic signal with a carrier oscillator
  // Web Audio trick: use a gain node's gain as the modulator input
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = 50; // 50Hz gives metallic robotic quality

  const ringGain = ctx.createGain();
  ringGain.gain.value = 0; // gain driven by carrier

  // Light bandpass to keep robot voice centered
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1000;
  bp.Q.value = 0.5;
  nodes.push(bp);

  // Tremolo effect using a second oscillator to modulate gain
  const tremolo = ctx.createGain();
  const tremoloLfo = ctx.createOscillator();
  const tremoloGain = ctx.createGain();
  tremoloLfo.frequency.value = 8;
  tremoloGain.gain.value = 0.4;
  tremoloLfo.connect(tremoloGain);
  tremoloGain.connect(tremolo.gain);
  tremoloLfo.start();

  const distort = ctx.createWaveShaper();
  distort.curve = makeDistortionCurve(80);
  nodes.push(distort);

  src.connect(bp);
  bp.connect(distort);
  distort.connect(tremolo);
  carrier.connect(ringGain.gain as unknown as AudioNode);
  carrier.start();

  nodes.push(tremolo);
  return { nodes, out: tremolo };
}

function buildMegaphone(ctx: AudioContext, src: AudioNode): { nodes: AudioNode[]; out: AudioNode } {
  const nodes: AudioNode[] = [];

  // 1. High-pass: cut body below 500Hz
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 500;
  hp.Q.value = 1.0;
  nodes.push(hp);

  // 2. Overdrive clipping
  const distort = ctx.createWaveShaper();
  distort.curve = makeDistortionCurve(200);
  distort.oversample = '4x';
  nodes.push(distort);

  // 3. Slapback echo (15ms)
  const delay = ctx.createDelay(0.1);
  delay.delayTime.value = 0.015;
  const feedbackGain = ctx.createGain();
  feedbackGain.gain.value = 0.25;

  const wet = ctx.createGain();
  wet.gain.value = 0.3;
  const dry = ctx.createGain();
  dry.gain.value = 0.7;

  const mix = ctx.createGain();
  mix.gain.value = 1.0;

  src.connect(hp);
  hp.connect(distort);
  distort.connect(dry);
  distort.connect(delay);
  delay.connect(feedbackGain);
  feedbackGain.connect(delay);
  delay.connect(wet);
  dry.connect(mix);
  wet.connect(mix);
  nodes.push(mix);

  return { nodes, out: mix };
}

function buildDemon(ctx: AudioContext, src: AudioNode): { nodes: AudioNode[]; out: AudioNode } {
  const nodes: AudioNode[] = [];

  // 1. Low-pass: cut highs above 2kHz for heavy feel
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2000;
  lp.Q.value = 0.7;
  nodes.push(lp);

  // 2. Sub-bass resonance boost at 100Hz
  const bass = ctx.createBiquadFilter();
  bass.type = 'peaking';
  bass.frequency.value = 100;
  bass.Q.value = 1.5;
  bass.gain.value = 10;
  nodes.push(bass);

  // 3. Pitch shift down −6 semitones
  src.connect(lp);
  lp.connect(bass);
  const pitched = createPitchShifter(ctx, bass, -6);
  nodes.push(pitched as AudioNode);

  return { nodes, out: pitched };
}

// ------------------------------------------------------------------ public API

/**
 * Build the voice FX processing chain and return the processed track.
 * Call once after getUserMedia; switch presets via setVoiceFilter().
 */
export function applyVoiceFx(rawStream: MediaStream): MediaStreamTrack {
  const ctx = audioContext();
  if (!ctx) {
    // AudioContext unavailable — return raw track directly
    const raw = rawStream.getAudioTracks()[0];
    return raw!;
  }

  disposeVoiceFx();

  const src = ctx.createMediaStreamSource(rawStream);
  const outputGain = ctx.createGain();
  outputGain.gain.value = 1.0;
  const destination = ctx.createMediaStreamDestination();

  outputGain.connect(destination);

  activeChain = { nodes: [], destination, outputGain };
  processedStream = destination.stream;

  // Wire the initial filter (bypass)
  src.connect(outputGain);

  // Store src on chain for later re-wiring
  (activeChain as FxChain & { src: AudioNode }).src = src;

  return destination.stream.getAudioTracks()[0]!;
}

/**
 * Switch the active voice filter preset live — no mic re-acquisition needed.
 */
export function setVoiceFilter(filter: VoiceFilter): void {
  const chain = activeChain as (FxChain & { src: AudioNode }) | null;
  if (!chain) return;

  const ctx = audioContext();
  if (!ctx) return;

  // Disconnect old nodes
  try {
    chain.src.disconnect();
    chain.outputGain.disconnect();
    for (const n of chain.nodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  chain.nodes = [];
  chain.outputGain.connect(chain.destination);

  switch (filter) {
    case 'anime': {
      const { nodes, out } = buildAnime(ctx, chain.src);
      chain.nodes = nodes;
      out.connect(chain.outputGain);
      break;
    }
    case 'radio': {
      const { nodes, out } = buildRadio(ctx, chain.src);
      chain.nodes = nodes;
      out.connect(chain.outputGain);
      break;
    }
    case 'robot': {
      const { nodes, out } = buildRobot(ctx, chain.src);
      chain.nodes = nodes;
      out.connect(chain.outputGain);
      break;
    }
    case 'megaphone': {
      const { nodes, out } = buildMegaphone(ctx, chain.src);
      chain.nodes = nodes;
      out.connect(chain.outputGain);
      break;
    }
    case 'demon': {
      const { nodes, out } = buildDemon(ctx, chain.src);
      chain.nodes = nodes;
      out.connect(chain.outputGain);
      break;
    }
    default: {
      // 'none' — bypass
      buildNone(ctx, chain.src);
      chain.src.connect(chain.outputGain);
      break;
    }
  }
}

/**
 * Set the output gain for transmitted audio (0 = mute, 100 = normal, 200 = max boost).
 */
export function setOutputVolume(percent: number): void {
  if (!activeChain) return;
  const clamped = Math.max(0, Math.min(200, percent));
  activeChain.outputGain.gain.value = clamped / 100;
}

/** Get the processed stream for attaching to the VU meter analyser. */
export function getProcessedStream(): MediaStream | null {
  return processedStream;
}

/** Tear down all nodes and release resources. */
export function disposeVoiceFx(): void {
  if (!activeChain) return;
  const chain = activeChain as FxChain & { src?: AudioNode };
  try {
    chain.src?.disconnect();
    chain.outputGain.disconnect();
    chain.destination.disconnect();
    for (const n of chain.nodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  activeChain = null;
  processedStream = null;
}
